import process from "node:process";
import { bus } from "./shared/event-bus";
import { AxlEventBus } from "./shared/axl-bus";
import type { BusEvents } from "./shared/types";
import { loadEnvLocal, validateEnv, assertRequiredEnv, envOr } from "./shared/env";
import { startSwarmTracer } from "./shared/swarm-tracer";
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

loadEnvLocal();

function reportEnv(): void {
  const check = validateEnv();
  const warnings = assertRequiredEnv(check);
  for (const w of warnings) console.warn(`[hawkeye] WARN  ${w}`);
  for (const o of check.optional) {
    if (!o.ok) console.log(`[hawkeye] info  ${o.name} not set — ${o.enables} disabled`);
  }
}

async function initLlm(): Promise<{ llm: FallbackLlmClient | null; compute: OgComputeClient | null }> {
  let ogClient: OgComputeClient | null = null;
  try {
    ogClient = new OgComputeClient();
  } catch (err) {
    console.warn("[hawkeye] 0G Compute failed to construct:", (err as Error).message);
  }

  let fallbackClient: ClaudeLlmClient | OpenRouterClient | null = null;
  try {
    fallbackClient = new OpenRouterClient();
    console.log(`[hawkeye] OpenRouter ready (model: ${fallbackClient.model})`);
  } catch {
    try {
      fallbackClient = new ClaudeLlmClient();
      console.log("[hawkeye] Claude fallback ready");
    } catch (err) {
      console.warn("[hawkeye] No LLM fallback available:", (err as Error).message);
    }
  }

  if (!fallbackClient && !ogClient) {
    console.warn("[hawkeye] No LLM available — regex-only mode");
    return { llm: null, compute: null };
  }

  const client = new FallbackLlmClient(ogClient, fallbackClient);
  await client.ready();
  return { llm: client, compute: ogClient };
}

function initStorage(): OgStorageClient | null {
  try {
    return new OgStorageClient();
  } catch (err) {
    console.warn("[hawkeye] 0G Storage unavailable:", (err as Error).message);
    return null;
  }
}

function initRegistry(): RegistryClient | null {
  try {
    return new RegistryClient();
  } catch (err) {
    console.warn("[hawkeye] 0G Registry unavailable:", (err as Error).message);
    return null;
  }
}

async function initAxlBus(): Promise<AxlEventBus<BusEvents> | null> {
  if (!envOr("AXL_API_URL", "")) {
    console.log("[hawkeye] AXL_API_URL not set — using local EventEmitter bus");
    return null;
  }
  const axl = new AxlEventBus<BusEvents>();
  await axl.start();
  if (!axl.isConnected()) return null;

  // Bridge: forward local bus events to AXL peers, and AXL events to local bus
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
  console.error("[hawkeye] uncaught:", err.message);
});

function initKeeperHub(): KeeperHubClient | null {
  try {
    return new KeeperHubClient();
  } catch (err) {
    if (err instanceof KeeperHubError && err.reason === "NO_API_KEY") {
      console.log("[hawkeye] KH_API_KEY not set — KeeperHub disabled, direct submission only");
    } else {
      console.warn("[hawkeye] KeeperHub init failed:", (err as Error).message);
    }
    return null;
  }
}

async function main(): Promise<void> {
  console.log("[hawkeye] booting...");
  reportEnv();

  await checkOgBalance();

  const { llm, compute } = await initLlm();
  if (compute) await compute.waitForPendingTxs();
  const storage = initStorage();
  const registry = initRegistry();

  let wm: ReturnType<typeof createWalletManager> | null = null;
  try {
    wm = createWalletManager();
    console.log("[hawkeye] Privy wallet manager ready");
  } catch (err) {
    console.warn(
      "[hawkeye] Privy unavailable — running without agent wallets:",
      (err as Error).message,
    );
  }

  const keeperHub = initKeeperHub();

  const stopTracer = startSwarmTracer();

  // 0G audit trail: writes to Storage + Chain on every bus event
  const stopAudit = startAuditTrail({ storage, registry });

  // Gensyn AXL P2P bus (bridges events to remote nodes)
  const axl = await initAxlBus();

  // Strategy MUST start BEFORE Safety and Quote.
  const stopStrategy = startStrategyAgent({ llm: llm ?? undefined });
  const stopSafety = startSafetyAgent();
  const stopQuote = startQuoteAgent();
  const stopExecution = startExecutionAgent({ walletManager: wm, keeperHub });
  const stopResearch = startResearchAgent({ llm: llm ?? undefined });
  const stopMonitor = startMonitorAgent();
  const stopCopyTrade = startCopyTradeAgent();

  // Health subsystem registration
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

  // Bus event logging with health counter
  bus.on("ALPHA_FOUND", () => incrementBusEvents());
  bus.on("EXECUTE_SELL", (sell) => {
    incrementBusEvents();
    console.log(`[bus] EXECUTE_SELL pos=${sell.positionId} fraction=${sell.fraction}`);
  });
  bus.on("POSITION_UPDATE", () => incrementBusEvents());
  bus.on("QUOTE_FAILED", (qf) => {
    incrementBusEvents();
    console.log(`[bus] QUOTE_FAILED intent=${qf.intentId} reason=${qf.reason}`);
  });
  bus.on("TRADE_REQUEST", () => incrementBusEvents());
  bus.on("SAFETY_RESULT", () => incrementBusEvents());
  bus.on("QUOTE_RESULT", () => incrementBusEvents());
  bus.on("STRATEGY_DECISION", () => incrementBusEvents());
  bus.on("TRADE_EXECUTED", () => incrementBusEvents());

  let gateway: Awaited<ReturnType<typeof startTelegramGateway>> | null = null;
  try {
    gateway = await startTelegramGateway({ walletManager: wm, llm });
    console.log("[hawkeye] Telegram gateway live");
  } catch (err) {
    console.warn(
      "[hawkeye] Telegram gateway failed — running in headless mode:",
      (err as Error).message,
    );
  }

  console.log("[hawkeye] swarm ready — all agents online\n");

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
    console.log("\n[hawkeye] shutting down...");
    for (const fn of cleanups) fn();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[hawkeye] fatal:", err);
  process.exit(1);
});
