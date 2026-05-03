import { bus } from "../../shared/event-bus";
import type {
  SafetyReport,
  Quote,
  StrategyDecision,
  TradeIntent,
  LlmClient,
  UserConfirmedPayload,
  QuoteFailedPayload,
} from "../../shared/types";
import { composeSkillsPrompt } from "../../shared/skills";
import { getUserSkillOverrides } from "../../shared/user-skills";

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
        emitDecision({
          intentId: intent.intentId,
          decision: "REJECT",
          reason: "Timed out waiting for safety and quote results. Try again.",
          rejectedAt: Date.now(),
        });
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
        ...(quote.totalSupply ? { totalSupply: quote.totalSupply } : {}),
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

  const onQuoteFailed = (payload: QuoteFailedPayload): void => {
    const entry = pending.get(payload.intentId);
    if (!entry) return;
    pending.delete(payload.intentId);
    emitDecision({
      intentId: entry.intent.intentId,
      decision: "REJECT",
      reason: payload.reason,
      rejectedAt: Date.now(),
    });
    console.log(
      `[strategy] ${payload.intentId.slice(0, 8)} — REJECTED (quote failed: ${payload.reason.slice(0, 80)})`,
    );
  };

  bus.on("TRADE_REQUEST", onRequest);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("QUOTE_RESULT", onQuote);
  bus.on("QUOTE_FAILED", onQuoteFailed);
  bus.on("USER_CONFIRMED", onUserConfirmed);
  console.log("[strategy] agent started");

  return () => {
    bus.off("TRADE_REQUEST", onRequest);
    bus.off("SAFETY_RESULT", onSafety);
    bus.off("QUOTE_RESULT", onQuote);
    bus.off("QUOTE_FAILED", onQuoteFailed);
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

  // Sells short-circuit: never block an exit on chain-mismatch / liquidity gates.
  // If the user holds the token, they must always be able to attempt to sell —
  // blocking traps their funds. Mode-logic still emits warnings via the reason.
  if (intent.side === "sell") {
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
        ...(quote.totalSupply ? { totalSupply: quote.totalSupply } : {}),
      });
    }
    return;
  }

  // Validation gate: catch chain mismatches and bad data before execution
  const TESTNET_CHAINS = new Set([
    "sepolia",
    "goerli",
    "mumbai",
    "fuji",
    "base-sepolia",
    "basesepolia",
  ]);
  if (intent.chainHint && intent.chainHint !== quote.chainId) {
    const intentIsTestnet = TESTNET_CHAINS.has(intent.chainHint);
    const quoteIsTestnet = TESTNET_CHAINS.has(quote.chainId);
    if (intentIsTestnet !== quoteIsTestnet) {
      emitDecision({
        intentId: intent.intentId,
        decision: "REJECT",
        reason: `Chain mismatch: you requested ${intent.chainHint} but the token was found on ${quote.chainId}. Please specify the correct chain.`,
        rejectedAt: Date.now(),
      });
      console.log(
        `[strategy] ${intent.intentId} — REJECTED: chain mismatch (intent=${intent.chainHint}, quote=${quote.chainId})`,
      );
      return;
    }
  }
  if (!intent.chainHint && TESTNET_CHAINS.has(quote.chainId)) {
    emitDecision({
      intentId: intent.intentId,
      decision: "REJECT",
      reason: `Token resolved to testnet (${quote.chainId}) but no testnet was specified. If you meant to trade on testnet, say "buy on sepolia".`,
      rejectedAt: Date.now(),
    });
    console.log(`[strategy] ${intent.intentId} — REJECTED: unexpected testnet resolution`);
    return;
  }
  const isTestnetTrade = intent.chainHint ? TESTNET_CHAINS.has(intent.chainHint) : false;
  if (!isTestnetTrade && quote.liquidityUsd < 500) {
    emitDecision({
      intentId: intent.intentId,
      decision: "REJECT",
      reason: `Token has almost no liquidity ($${quote.liquidityUsd.toFixed(0)}). Too risky to trade.`,
      rejectedAt: Date.now(),
    });
    console.log(
      `[strategy] ${intent.intentId} — REJECTED: liquidity too low ($${quote.liquidityUsd})`,
    );
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
      ...(quote.totalSupply ? { totalSupply: quote.totalSupply } : {}),
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
  const isSell = intent.side === "sell";

  // Sells and swaps-out always execute — user already holds the token, blocking traps their funds
  if (isSell) {
    const warnings =
      safety.flags.length > 0
        ? ` (Warning: ${safety.flags.join(", ")} — sell may fail if token has transfer restrictions)`
        : "";
    return {
      intentId: intent.intentId,
      decision: "EXECUTE",
      reason: `${buildReason(safety, quote)}${warnings}`,
      approvedAt: Date.now(),
    };
  }

  // INSTANT mode: honeypot gets confirmation instead of hard reject
  if (urgency === "INSTANT") {
    if (safety.score === 0) {
      return {
        intentId: intent.intentId,
        decision: "AWAIT_USER_CONFIRM",
        reason: `HONEYPOT DETECTED (score ${safety.score}/100). This token is very likely a scam. Flags: ${safety.flags.join(", ")}. ${buildReason(safety, quote)}. Proceed anyway?`,
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

  // CAREFUL mode: high bar, confirm below 70
  if (urgency === "CAREFUL") {
    if (safety.score < 70) {
      return {
        intentId: intent.intentId,
        decision: "AWAIT_USER_CONFIRM",
        reason: `Safety score ${safety.score}/100 is below the CAREFUL threshold (70). Flags: ${safety.flags.join(", ") || "none"}. ${buildReason(safety, quote)}. Proceed anyway?`,
        expiresAt: Date.now() + 60_000,
      };
    }
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

  // NORMAL mode: confirm below 70 (never hard reject — let user decide), auto-approve 70+
  if (safety.score < 70) {
    const severity = safety.score === 0 ? "HONEYPOT DETECTED" : `Safety ${safety.score}/100`;
    return {
      intentId: intent.intentId,
      decision: "AWAIT_USER_CONFIRM",
      reason: `${severity}, flags: ${safety.flags.join(", ") || "none"}. ${buildReason(safety, quote)}. Proceed anyway?`,
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

    const skillsExt = composeSkillsPrompt("strategy", getUserSkillOverrides(intent.userId));
    const resp = await agentLlm.infer({
      system: STRATEGY_PROMPT + skillsExt,
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
