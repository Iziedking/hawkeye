import { bus } from "../../shared/event-bus";
import type {
  SafetyReport,
  Quote,
  StrategyDecision,
  TradeIntent,
  LlmClient,
  UserConfirmedPayload,
} from "../../shared/types";

type PendingTrade = {
  intent: TradeIntent;
  safety: SafetyReport | null;
  quote: Quote | null;
};

const pending = new Map<string, PendingTrade>();
const awaitingConfirm = new Map<string, PendingTrade>();
const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MERGE_TIMEOUT_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 60_000;

export type StrategyDeps = {
  llm?: LlmClient;
};

let agentLlm: LlmClient | null = null;

export function startStrategyAgent(deps: StrategyDeps = {}): () => void {
  agentLlm = deps.llm ?? null;

  const onRequest = (intent: TradeIntent): void => {
    pending.set(intent.intentId, { intent, safety: null, quote: null });
    setTimeout(() => {
      if (pending.has(intent.intentId)) {
        pending.delete(intent.intentId);
        console.log(`[strategy] timeout waiting for results — intent=${intent.intentId}`);
      }
    }, MERGE_TIMEOUT_MS);
  };

  const onSafety = (report: SafetyReport): void => {
    const entry = pending.get(report.intentId);
    if (!entry) return;
    entry.safety = report;
    void tryDecide(entry).catch((err) => {
      console.error("[strategy] uncaught error:", err);
    });
  };

  const onQuote = (quote: Quote): void => {
    const entry = pending.get(quote.intentId);
    if (!entry) return;
    entry.quote = quote;
    void tryDecide(entry).catch((err) => {
      console.error("[strategy] uncaught error:", err);
    });
  };

  const onUserConfirmed = (payload: UserConfirmedPayload): void => {
    const entry = awaitingConfirm.get(payload.intentId);
    if (!entry) return;
    awaitingConfirm.delete(payload.intentId);
    const timer = confirmTimers.get(payload.intentId);
    if (timer) {
      clearTimeout(timer);
      confirmTimers.delete(payload.intentId);
    }

    const { intent, quote } = entry;
    if (!quote) return;

    if (payload.confirmed) {
      const reason = `User confirmed. ${buildReason(entry.safety!, quote)}`;
      emitDecision({
        intentId: intent.intentId,
        decision: "EXECUTE",
        reason,
        approvedAt: Date.now(),
      });
      bus.emit("EXECUTE_TRADE", {
        intentId: intent.intentId,
        positionId: `pos-${intent.intentId}`,
        userId: intent.userId,
        address: intent.address,
        chainId: quote.chainId,
        filled: intent.amount,
        entryPriceUsd: quote.priceUsd,
        txHash: "",
        remainingExits: intent.exits,
        openedAt: Date.now(),
      });
      console.log(`[strategy] ${intent.intentId} — user confirmed, executing`);
    } else {
      emitDecision({
        intentId: intent.intentId,
        decision: "REJECT",
        reason: "User rejected the trade",
        rejectedAt: Date.now(),
      });
      console.log(`[strategy] ${intent.intentId} — user rejected`);
    }
  };

  bus.on("TRADE_REQUEST", onRequest);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("QUOTE_RESULT", onQuote);
  bus.on("USER_CONFIRMED", onUserConfirmed);
  console.log("[strategy] agent started");

  return () => {
    bus.off("TRADE_REQUEST", onRequest);
    bus.off("SAFETY_RESULT", onSafety);
    bus.off("QUOTE_RESULT", onQuote);
    bus.off("USER_CONFIRMED", onUserConfirmed);
    for (const timer of confirmTimers.values()) clearTimeout(timer);
    confirmTimers.clear();
    awaitingConfirm.clear();
  };
}

async function tryDecide(entry: PendingTrade): Promise<void> {
  if (entry.safety === null || entry.quote === null) return;

  const { intent, safety, quote } = entry;
  pending.delete(intent.intentId);

  if (quote.route === "none") {
    emitDecision({
      intentId: intent.intentId,
      decision: "REJECT",
      reason: "No trading pair found on any DEX",
      rejectedAt: Date.now(),
    });
    return;
  }

  const decision = applyModeLogic(intent, safety, quote);

  if (agentLlm) {
    const enhanced = await enhanceReason(decision, intent, safety, quote);
    if (enhanced) decision.reason = enhanced;
  }

  emitDecision(decision);

  if (decision.decision === "EXECUTE") {
    bus.emit("EXECUTE_TRADE", {
      intentId: intent.intentId,
      positionId: `pos-${intent.intentId}`,
      userId: intent.userId,
      address: intent.address,
      chainId: quote.chainId,
      filled: intent.amount,
      entryPriceUsd: quote.priceUsd,
      txHash: "",
      remainingExits: intent.exits,
      openedAt: Date.now(),
    });
  } else if (decision.decision === "AWAIT_USER_CONFIRM") {
    awaitingConfirm.set(intent.intentId, entry);
    const timer = setTimeout(() => {
      if (awaitingConfirm.has(intent.intentId)) {
        awaitingConfirm.delete(intent.intentId);
        confirmTimers.delete(intent.intentId);
        emitDecision({
          intentId: intent.intentId,
          decision: "REJECT",
          reason: "Confirmation timed out (60s)",
          rejectedAt: Date.now(),
        });
        console.log(`[strategy] ${intent.intentId} — confirmation expired`);
      }
    }, CONFIRM_TIMEOUT_MS);
    confirmTimers.set(intent.intentId, timer);
  }

  console.log(
    `[strategy] ${intent.intentId} — ${decision.decision} (safety=${safety.score} mode=${intent.urgency})`,
  );
}

function applyModeLogic(intent: TradeIntent, safety: SafetyReport, quote: Quote): StrategyDecision {
  const { urgency } = intent;

  // INSTANT mode: always execute, attach warnings inline
  if (urgency === "INSTANT") {
    if (safety.score === 0) {
      return {
        intentId: intent.intentId,
        decision: "REJECT",
        reason: `Token is a confirmed honeypot (score ${safety.score}/100)`,
        rejectedAt: Date.now(),
      };
    }
    return {
      intentId: intent.intentId,
      decision: "EXECUTE",
      reason: buildReason(safety, quote),
      approvedAt: Date.now(),
    };
  }

  // CAREFUL mode: high bar, auto-reject below 70
  if (urgency === "CAREFUL") {
    if (safety.score < 70) {
      return {
        intentId: intent.intentId,
        decision: "REJECT",
        reason: `Safety score ${safety.score}/100 is below the CAREFUL threshold (70). Flags: ${safety.flags.join(", ") || "none"}`,
        rejectedAt: Date.now(),
      };
    }
    // Even above 70, ask for confirmation if there are any flags
    if (safety.flags.length > 0) {
      return {
        intentId: intent.intentId,
        decision: "AWAIT_USER_CONFIRM",
        reason: `Safety ${safety.score}/100 with flags: ${safety.flags.join(", ")}. ${buildReason(safety, quote)}`,
        expiresAt: Date.now() + 60_000,
      };
    }
    return {
      intentId: intent.intentId,
      decision: "EXECUTE",
      reason: buildReason(safety, quote),
      approvedAt: Date.now(),
    };
  }

  // NORMAL mode: reject below 50, confirm between 50-69, auto-approve 70+
  if (safety.score < 50) {
    return {
      intentId: intent.intentId,
      decision: "REJECT",
      reason: `Safety score ${safety.score}/100 too low. Flags: ${safety.flags.join(", ")}`,
      rejectedAt: Date.now(),
    };
  }

  if (safety.score < 70) {
    return {
      intentId: intent.intentId,
      decision: "AWAIT_USER_CONFIRM",
      reason: `Safety ${safety.score}/100, flags: ${safety.flags.join(", ") || "none"}. ${buildReason(safety, quote)}`,
      expiresAt: Date.now() + 60_000,
    };
  }

  return {
    intentId: intent.intentId,
    decision: "EXECUTE",
    reason: buildReason(safety, quote),
    approvedAt: Date.now(),
  };
}

function buildReason(safety: SafetyReport, quote: Quote): string {
  return `Price $${quote.priceUsd} | Liq $${quote.liquidityUsd.toLocaleString()} | Slippage ${quote.expectedSlippagePct.toFixed(2)}% | Safety ${safety.score}/100`;
}

const STRATEGY_PROMPT = [
  "You are HAWKEYE's strategy analyst. Generate a brief 2-3 sentence trade analysis.",
  "Be direct. No markdown. No fluff. Include the key data points that informed the decision.",
  "If rejecting, explain the specific risk. If executing, explain why the risk/reward is acceptable.",
].join("\n");

async function enhanceReason(
  decision: StrategyDecision,
  intent: TradeIntent,
  safety: SafetyReport,
  quote: Quote,
): Promise<string | null> {
  if (!agentLlm) return null;
  try {
    const data = [
      `Decision: ${decision.decision}`,
      `Token: ${intent.address} on ${quote.chainId}`,
      `Price: $${quote.priceUsd}`,
      `Liquidity: $${quote.liquidityUsd.toLocaleString()}`,
      `Slippage: ${quote.expectedSlippagePct.toFixed(2)}%`,
      `Safety: ${safety.score}/100`,
      safety.flags.length > 0 ? `Flags: ${safety.flags.join(", ")}` : "No safety flags",
      `Mode: ${intent.urgency}`,
      `Route: ${quote.route}`,
    ].join("\n");

    const resp = await agentLlm.infer({
      system: STRATEGY_PROMPT,
      user: data,
      temperature: 0.3,
      maxTokens: 150,
    });
    const text = resp.text.trim();
    if (text.length > 10) return text;
  } catch {
    // LLM failed, static reason is fine
  }
  return null;
}

function emitDecision(decision: StrategyDecision): void {
  bus.emit("STRATEGY_DECISION", decision);
}
