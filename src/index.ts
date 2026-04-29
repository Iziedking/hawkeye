// Main startup. Boots all agents, connects the gateway to the event bus.

import process from "node:process";
import { bus } from "./shared/event-bus";
import { startGateway } from "./gateway/index";
import { startLightSafetyAgent } from "./agents/safety-light";
import { startQuoteAgent } from "./agents/quote";
import { startExecutionAgent } from "./agents/execution";
import { startEducationAgent } from "./agents/education";
import type { Quote, SafetyReport } from "./shared/types";

async function main(): Promise<void> {
  console.log("[hawkeye] booting agent swarm...");

  const stopSafety = startLightSafetyAgent();
  const stopQuote = startQuoteAgent();
  const stopExecution = startExecutionAgent();
  const stopEducation = startEducationAgent();

  // Local lightweight strategy loop for the current repo layout.
  // It correlates quote+safety and emits a decision for execution.
  const quoteCache = new Map<string, Quote>();
  const safetyCache = new Map<string, SafetyReport>();
  const onQuote = (quote: Quote): void => {
    const safety = safetyCache.get(quote.intentId);
    if (!safety) {
      quoteCache.set(quote.intentId, quote);
      return;
    }

    safetyCache.delete(quote.intentId);
    bus.emit("STRATEGY_DECISION", {
      intentId: quote.intentId,
      decision: safety.score >= 40 ? "EXECUTE" : "REJECT",
      reason:
        safety.score >= 40
          ? `Auto-approve: safety=${safety.score} route=${quote.route}`
          : `Rejected: low safety score ${safety.score}`,
      ...(safety.score >= 40
        ? { approvedAt: Date.now() }
        : { rejectedAt: Date.now() }),
    });
  };
  const onSafety = (safety: SafetyReport): void => {
    const quote = quoteCache.get(safety.intentId);
    if (!quote) {
      safetyCache.set(safety.intentId, safety);
      return;
    }

    quoteCache.delete(safety.intentId);
    bus.emit("STRATEGY_DECISION", {
      intentId: safety.intentId,
      decision: safety.score >= 40 ? "EXECUTE" : "REJECT",
      reason:
        safety.score >= 40
          ? `Auto-approve: safety=${safety.score} route=${quote.route}`
          : `Rejected: low safety score ${safety.score}`,
      ...(safety.score >= 40
        ? { approvedAt: Date.now() }
        : { rejectedAt: Date.now() }),
    });
  };
  bus.on("QUOTE_RESULT", onQuote);
  bus.on("SAFETY_RESULT", onSafety);

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
    stopExecution();
    stopEducation();
    bus.off("QUOTE_RESULT", onQuote);
    bus.off("SAFETY_RESULT", onSafety);
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
