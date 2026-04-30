import process from "node:process";
import { bus } from "./shared/event-bus";
import { loadEnvLocal, validateEnv, assertRequiredEnv } from "./shared/env";
import { startSwarmTracer } from "./shared/swarm-tracer";
import { startTelegramGateway } from "./gateway/telegram-gateway";
import { createWalletManager } from "./integrations/privy/index";
import { OgComputeClient } from "./integrations/0g/compute";
import { ClaudeLlmClient, FallbackLlmClient } from "./integrations/claude/index";

import { startStrategyAgent } from "./agents/strategy/index";
import { startSafetyAgent } from "./agents/safety/index";
import { startQuoteAgent } from "./agents/quote/index";
import { startExecutionAgent } from "./agents/execution/index";
import { startResearchAgent } from "./agents/research/index";
import { startMonitorAgent } from "./agents/monitor/index";
import { startCopyTradeAgent } from "./agents/copy-trade/index";

loadEnvLocal();

function reportEnv(): void {
  const check = validateEnv();
  const warnings = assertRequiredEnv(check);
  for (const w of warnings) console.warn(`[hawkeye] WARN  ${w}`);
  for (const o of check.optional) {
    if (!o.ok) console.log(`[hawkeye] info  ${o.name} not set — ${o.enables} disabled`);
  }
}

async function initLlm(): Promise<FallbackLlmClient | null> {
  let ogClient: OgComputeClient | null = null;
  try {
    ogClient = new OgComputeClient();
  } catch (err) {
    console.warn("[hawkeye] 0G Compute failed to construct:", (err as Error).message);
  }

  let claudeClient: ClaudeLlmClient | null = null;
  try {
    claudeClient = new ClaudeLlmClient();
  } catch (err) {
    console.warn("[hawkeye] Claude fallback unavailable:", (err as Error).message);
  }

  if (!claudeClient && !ogClient) {
    console.warn("[hawkeye] No LLM available — regex-only mode");
    return null;
  }

  const client = new FallbackLlmClient(ogClient, claudeClient);
  await client.ready();
  return client;
}

async function main(): Promise<void> {
  console.log("[hawkeye] booting...");
  reportEnv();

  const llm = await initLlm();

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

  const stopTracer = startSwarmTracer();

  // Strategy MUST start BEFORE Safety and Quote.
  // It registers a TRADE_REQUEST handler to record the trade context before
  // a safety cache hit emits SAFETY_RESULT synchronously in the same tick.
  const stopStrategy = startStrategyAgent({ llm: llm ?? undefined });
  const stopSafety = startSafetyAgent();
  const stopQuote = startQuoteAgent();
  const stopExecution = startExecutionAgent();
  const stopResearch = startResearchAgent({ llm: llm ?? undefined });
  const stopMonitor = startMonitorAgent();
  const stopCopyTrade = startCopyTradeAgent();

  bus.on("ALPHA_FOUND", (alpha) => {
    console.log(
      `[bus] ALPHA_FOUND addr=${alpha.address} chain=${alpha.chainId} safety=${alpha.safetyScore} liq=$${alpha.liquidityUsd}`,
    );
  });
  bus.on("EXECUTE_SELL", (sell) => {
    console.log(`[bus] EXECUTE_SELL pos=${sell.positionId} fraction=${sell.fraction}`);
  });
  bus.on("POSITION_UPDATE", (u) => {
    if (u.pnlPct >= 50 || u.pnlPct <= -20) {
      console.log(
        `[bus] POSITION_UPDATE pos=${u.positionId} price=$${u.priceUsd} pnl=${u.pnlPct.toFixed(1)}%`,
      );
    }
  });
  bus.on("QUOTE_FAILED", (qf) => {
    console.log(`[bus] QUOTE_FAILED intent=${qf.intentId} reason=${qf.reason}`);
  });

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
    stopStrategy,
    () => stopSafety.stop(),
    stopQuote,
    stopExecution,
    () => stopResearch.stop(),
    () => stopMonitor.stop(),
    () => stopCopyTrade.stop(),
    () => gateway?.stop(),
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
