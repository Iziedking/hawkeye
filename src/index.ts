import process from "node:process";
import { bus } from "./shared/event-bus";
import { AxlEventBus } from "./shared/axl-bus";
import type { BusEvents } from "./shared/types";
import { loadEnvLocal, validateEnv, assertRequiredEnv, envOr } from "./shared/env";
import { startSwarmTracer } from "./shared/swarm-tracer";
import { log, sponsors } from "./shared/logger";
import {
  registerHealthCheck,
  setAgentList,
  incrementBusEvents,
  startHealthServer,
  stopHealthServer,
} from "./shared/health";
import { startTelegramGateway } from "./gateway/telegram-gateway";
import { createWalletManager } from "./integrations/privy/index";
import { OgComputeClient } from "./integrations/0g/compute";
import { OgStorageClient } from "./integrations/0g/storage";
import { RegistryClient } from "./integrations/0g/registry-client";
import { checkOgBalance } from "./integrations/0g/shared-signer";
import { startAuditTrail } from "./integrations/0g/audit-trail";
import { ClaudeLlmClient, FallbackLlmClient } from "./integrations/claude/index";
import { OpenRouterClient } from "./integrations/openrouter/index";

import { startStrategyAgent } from "./agents/strategy/index";
import { startSafetyAgent } from "./agents/safety/index";
import { startQuoteAgent } from "./agents/quote/index";
import { startExecutionAgent } from "./agents/execution/index";
import { startResearchAgent } from "./agents/research/index";
import { startMonitorAgent } from "./agents/monitor/index";
import { startCopyTradeAgent } from "./agents/copy-trade/index";
import { KeeperHubClient, KeeperHubError } from "./integrations/keeperhub/index";
import { ArkhamClient } from "./integrations/arkham/index";

loadEnvLocal();

function reportEnv(): void {
  const check = validateEnv();
  const warnings = assertRequiredEnv(check);
  for (const w of warnings) log.warn(w);
  for (const o of check.optional) {
    if (!o.ok) log.boot(`${o.name} not set, ${o.enables} disabled`);
  }
}

async function initLlm(): Promise<{ llm: FallbackLlmClient | null; compute: OgComputeClient | null }> {
  let ogClient: OgComputeClient | null = null;
  try {
    ogClient = new OgComputeClient();
    sponsors.og.compute = true;
    log.og("compute", "client initialized");
  } catch (err) {
    log.warn(`0G Compute: ${(err as Error).message}`);
  }

  let fallbackClient: ClaudeLlmClient | OpenRouterClient | null = null;
  try {
    fallbackClient = new OpenRouterClient();
    log.boot(`OpenRouter ready (model: ${fallbackClient.model})`);
  } catch {
    try {
      fallbackClient = new ClaudeLlmClient();
      log.boot("Claude fallback ready");
    } catch (err) {
      log.warn(`No LLM fallback: ${(err as Error).message}`);
    }
  }

  if (!fallbackClient && !ogClient) {
    log.warn("No LLM available, regex-only mode");
    return { llm: null, compute: null };
  }

  const client = new FallbackLlmClient(ogClient, fallbackClient, (m) => log.og("compute", m));
  await client.ready();
  return { llm: client, compute: ogClient };
}

function initStorage(): OgStorageClient | null {
  try {
    const s = new OgStorageClient();
    sponsors.og.storage = true;
    log.og("storage", "client initialized");
    return s;
  } catch (err) {
    log.warn(`0G Storage: ${(err as Error).message}`);
    return null;
  }
}

function initRegistry(): RegistryClient | null {
  try {
    const r = new RegistryClient();
    sponsors.og.chain = true;
    log.og("chain", `contract ${r.address.slice(0, 10)}...`);
    return r;
  } catch (err) {
    log.warn(`0G Registry: ${(err as Error).message}`);
    return null;
  }
}

async function initAxlBus(): Promise<AxlEventBus<BusEvents> | null> {
  if (!envOr("AXL_API_URL", "")) {
    log.gensyn("AXL_API_URL not set, using local EventEmitter bus");
    return null;
  }
  const axl = new AxlEventBus<BusEvents>();
  await axl.start();
  if (!axl.isConnected()) return null;

  sponsors.gensyn.connected = true;
  sponsors.gensyn.peers = axl.getPeerCount();

  const bridgedEvents: Array<keyof BusEvents> = [
    "TRADE_REQUEST",
    "SAFETY_RESULT",
    "QUOTE_RESULT",
    "STRATEGY_DECISION",
    "TRADE_EXECUTED",
    "EXECUTE_SELL",
    "ALPHA_FOUND",
    "RESEARCH_REQUEST",
    "RESEARCH_RESULT",
    "POSITION_UPDATE",
  ];

  for (const event of bridgedEvents) {
    let forwarding = false;
    bus.on(event, ((payload: BusEvents[typeof event]) => {
      if (forwarding) return;
      forwarding = true;
      axl.emit(event, payload);
      forwarding = false;
    }) as never);

    axl.on(event, ((payload: BusEvents[typeof event]) => {
      if (forwarding) return;
      forwarding = true;
      bus.emit(event, payload);
      forwarding = false;
    }) as never);
  }

  return axl;
}

process.on("uncaughtException", (err) => {
  if (err instanceof RangeError && err.message.includes("call stack")) return;
  log.error("uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

function initKeeperHub(): KeeperHubClient | null {
  try {
    const kh = new KeeperHubClient();
    sponsors.keeper.active = true;
    log.keeper("client initialized, MEV protection active");
    return kh;
  } catch (err) {
    if (err instanceof KeeperHubError && err.reason === "NO_API_KEY") {
      log.boot("KH_API_KEY not set, KeeperHub disabled");
    } else {
      log.warn(`KeeperHub: ${(err as Error).message}`);
    }
    return null;
  }
}

async function main(): Promise<void> {
  log.boot("initializing...");
  reportEnv();

  await checkOgBalance();

  const { llm, compute } = await initLlm();
  if (compute) await compute.waitForPendingTxs();
  const storage = initStorage();
  const registry = initRegistry();

  const keeperHub = initKeeperHub();

  // Auto-fetch KeeperHub execution wallet address for MEV-protected swaps
  if (keeperHub && !envOr("KH_WALLET_ADDRESS", "")) {
    const addr = await keeperHub.fetchWalletAddress();
    if (addr) {
      process.env["KH_WALLET_ADDRESS"] = addr;
      log.keeper(`execution wallet: ${addr.slice(0, 10)}...`);
    }
  }
  if (keeperHub && envOr("KH_WALLET_ADDRESS", "")) {
    log.keeper("mainnet swaps will route through KeeperHub (MEV protection)");
  }

  let wm: ReturnType<typeof createWalletManager> | null = null;
  try {
    wm = createWalletManager();
    log.privy("wallet manager ready (per-user wallets)");
  } catch (err) {
    log.warn(`Privy: ${(err as Error).message}`);
  }

  const stopTracer = startSwarmTracer();
  const stopAudit = startAuditTrail({ storage, registry });
  const axl = await initAxlBus();

  // Strategy MUST start BEFORE Safety and Quote
  const stopStrategy = startStrategyAgent(llm ? { llm } : {});
  const stopSafety = startSafetyAgent();
  const stopQuote = startQuoteAgent();
  const stopExecution = startExecutionAgent({ walletManager: wm, keeperHub });
  let arkham: ArkhamClient | undefined;
  try {
    arkham = new ArkhamClient();
    log.boot("Arkham Intelligence client initialized");
  } catch {
    log.warn("ARKHAM_API_KEY not set — research will run without Arkham data");
  }
  const stopResearch = startResearchAgent({ llm: llm ?? undefined, arkham });
  const stopMonitor = startMonitorAgent();
  const stopCopyTrade = startCopyTradeAgent();

  sponsors.uniswap.active = true;

  const agentNames = [
    "Safety",
    "Quote",
    "Strategy",
    "Execution",
    "Research",
    "Monitor",
    "CopyTrade",
  ];
  setAgentList(agentNames);

  registerHealthCheck(() => ({
    name: "LLM",
    ok: llm !== null,
    detail: llm ? "0G Compute" : "regex-only",
  }));
  registerHealthCheck(() => ({
    name: "Wallets",
    ok: wm !== null,
    detail: wm ? "Privy" : "unavailable",
  }));
  registerHealthCheck(() => ({
    name: "0G Storage",
    ok: storage !== null,
    detail: storage ? "active" : "unavailable",
  }));
  registerHealthCheck(() => ({
    name: "0G Registry",
    ok: registry !== null,
    detail: registry ? registry.address.slice(0, 10) + "..." : "unavailable",
  }));
  registerHealthCheck(() => ({
    name: "KeeperHub",
    ok: keeperHub !== null && !keeperHub.circuitOpen,
    detail: keeperHub
      ? keeperHub.circuitOpen ? "circuit open" : "active"
      : "unavailable",
  }));
  registerHealthCheck(() => ({
    name: "Gensyn AXL",
    ok: axl !== null && axl.isConnected(),
    detail: axl?.isConnected() ? `${axl.getPeerCount()} peers` : "local-only",
  }));

  startHealthServer(Number(process.env["HEALTH_PORT"] ?? 8080));

  bus.on("ALPHA_FOUND", () => incrementBusEvents());
  bus.on("EXECUTE_SELL", (sell) => {
    incrementBusEvents();
    log.bus("EXECUTE_SELL", `pos=${sell.positionId} fraction=${sell.fraction}`);
  });
  bus.on("POSITION_UPDATE", () => incrementBusEvents());
  bus.on("QUOTE_FAILED", (qf) => {
    incrementBusEvents();
    log.bus("QUOTE_FAILED", `intent=${qf.intentId} reason=${qf.reason.slice(0, 80)}`);
  });
  bus.on("TRADE_REQUEST", () => incrementBusEvents());
  bus.on("SAFETY_RESULT", () => incrementBusEvents());
  bus.on("QUOTE_RESULT", () => incrementBusEvents());
  bus.on("STRATEGY_DECISION", () => incrementBusEvents());
  bus.on("TRADE_EXECUTED", () => incrementBusEvents());

  let gateway: Awaited<ReturnType<typeof startTelegramGateway>> | null = null;
  try {
    gateway = await startTelegramGateway({ walletManager: wm, llm });
  } catch (err) {
    log.warn(`Telegram gateway failed: ${(err as Error).message}`);
  }

  const ogActuallyHealthy = llm?.ogHealthy ?? false;
  if (!ogActuallyHealthy) sponsors.og.compute = false;

  const readyCfg: import("./shared/logger").ReadyConfig = {
    ogCompute: ogActuallyHealthy,
    ogStorage: sponsors.og.storage,
    ogChain: sponsors.og.chain,
    gensyn: sponsors.gensyn.connected,
    gensynPeers: sponsors.gensyn.peers,
    uniswap: sponsors.uniswap.active,
    keeperHub: sponsors.keeper.active,
    privy: wm !== null,
    llmFallback: llm?.usingFallback ? (llm.fallbackName ?? "OpenRouter") : null,
    agentCount: agentNames.length,
  };
  if (registry) readyCfg.ogChainAddr = registry.address;
  log.ready(readyCfg);

  const cleanups = [
    stopTracer,
    stopAudit,
    stopStrategy,
    () => stopSafety.stop(),
    stopQuote,
    stopExecution,
    () => stopResearch.stop(),
    () => stopMonitor.stop(),
    () => stopCopyTrade.stop(),
    () => gateway?.stop(),
    () => axl?.stop(),
    stopHealthServer,
  ];

  const shutdown = (): void => {
    log.boot("shutting down...");
    for (const fn of cleanups) fn();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
