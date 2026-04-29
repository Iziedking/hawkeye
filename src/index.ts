// Main startup. Boots all agents, connects the gateway to the event bus.

import process from "node:process";
import { bus } from "./shared/event-bus";
import { startGateway } from "./gateway/index";
import { startSafetyAgent } from "./agents/safety/index";
import { startQuoteAgent } from "./agents/quote/index";
import { startStrategyAgent } from "./agents/strategy/index";
import { startResearchAgent } from "./agents/research/index";
import { startExecutionAgent } from "./agents/execution";
import { startEducationAgent } from "./agents/education";

async function main(): Promise<void> {
  console.log("[hawkeye] booting agent swarm...");

  const stopSafety = startSafetyAgent();
  const stopQuote = startQuoteAgent();
  const stopStrategy = startStrategyAgent();
  const research = startResearchAgent();
  const stopExecution = startExecutionAgent();
  const stopEducation = startEducationAgent();

  // Log bus activity for debugging
  bus.on("TRADE_REQUEST", (intent) => {
    console.log(`\n[bus] TRADE_REQUEST intent=${intent.intentId} addr=${intent.address} chain=${intent.chain} urgency=${intent.urgency}`);
  });
  bus.on("SAFETY_RESULT", (report) => {
    console.log(`[bus] SAFETY_RESULT intent=${report.intentId} score=${report.score} flags=[${report.flags.join(",")}]`);
  });
  bus.on("QUOTE_RESULT", (quote) => {
    console.log(`[bus] QUOTE_RESULT intent=${quote.intentId} price=$${quote.priceUsd} liq=$${quote.liquidityUsd}`);
  });
  bus.on("STRATEGY_DECISION", (d) => {
    console.log(`[bus] STRATEGY_DECISION intent=${d.intentId} decision=${d.decision} reason=${d.reason}`);
  });
  bus.on("EXECUTE_TRADE", (pos) => {
    console.log(`[bus] EXECUTE_TRADE intent=${pos.intentId} chain=${pos.chainId} price=$${pos.entryPriceUsd}`);
  });
  bus.on("RESEARCH_REQUEST", (req) => {
    console.log(`[bus] RESEARCH_REQUEST id=${req.requestId} addr=${req.address ?? "none"} chain=${req.chain ?? "unknown"}`);
  });
  bus.on("GENERAL_QUERY_REQUEST", (req) => {
    console.log(`[bus] GENERAL_QUERY_REQUEST id=${req.requestId} query=${req.query.slice(0, 60)}`);
  });
  bus.on("ALPHA_FOUND", (alpha) => {
    console.log(`[bus] ALPHA_FOUND addr=${alpha.address} chain=${alpha.chainId} safety=${alpha.safetyScore} liq=$${alpha.liquidityUsd}`);
  });
  bus.on("RESEARCH_RESULT", (res) => {
    console.log(`[bus] RESEARCH_RESULT id=${res.requestId} addr=${res.address.slice(0, 14)} safety=${res.safetyScore ?? "N/A"}`);
  });

  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    gateway = await startGateway();
    console.log("[hawkeye] gateway connected to OpenClaw");
  } catch (err) {
    console.warn("[hawkeye] gateway failed to connect — running in headless mode:", (err as Error).message);
    console.warn("[hawkeye] agents are running, but no messages will flow until the gateway connects");
  }

  console.log("[hawkeye] swarm is live\n");

  const shutdown = (): void => {
    console.log("\n[hawkeye] shutting down...");
    stopSafety();
    stopQuote();
    stopStrategy();
    research.stop();
    stopExecution();
    stopEducation();
    gateway?.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[hawkeye] fatal:", err);
  process.exit(1);
});
