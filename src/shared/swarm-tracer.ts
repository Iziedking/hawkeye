import { bus } from "./event-bus";
import { log } from "./logger";
import type {
  TradeIntent,
  SafetyReport,
  Quote,
  StrategyDecision,
  TradeExecutedPayload,
  ResearchRequest,
  ResearchResult,
} from "./types";

const tradeT0 = new Map<string, number>();
const researchT0 = new Map<string, number>();

function delta(id: string, map: Map<string, number>): string {
  const t0 = map.get(id);
  if (t0 === undefined) return "";
  return `+${Date.now() - t0}ms`;
}

export function startSwarmTracer(): () => void {
  const onRequest = (intent: TradeIntent): void => {
    tradeT0.set(intent.intentId, Date.now());
    log.bus("TRADE_REQUEST", `intent=${intent.intentId.slice(0, 8)} addr=${intent.address.slice(0, 12)}...`);
  };

  const onSafety = (r: SafetyReport): void => {
    if (!tradeT0.has(r.intentId)) return;
    const flags = r.flags.length > 0 ? ` flags=[${r.flags.join(",")}]` : "";
    log.agent("safety", `${r.score}/100${flags} ${delta(r.intentId, tradeT0)}`);
  };

  const onQuote = (q: Quote): void => {
    if (!tradeT0.has(q.intentId)) return;
    const liq =
      q.liquidityUsd >= 1_000_000
        ? `$${(q.liquidityUsd / 1_000_000).toFixed(1)}M`
        : `$${(q.liquidityUsd / 1_000).toFixed(0)}K`;
    log.uniswap("quote", `$${q.priceUsd} liq=${liq} slip=${q.expectedSlippagePct.toFixed(1)}% ${delta(q.intentId, tradeT0)}`);
  };

  const onStrategy = (d: StrategyDecision): void => {
    if (!tradeT0.has(d.intentId)) return;
    log.agent("strategy", `${d.decision} ${delta(d.intentId, tradeT0)}`);
  };

  const onExecuted = (pos: TradeExecutedPayload): void => {
    if (!tradeT0.has(pos.intentId)) return;
    log.trade("FILLED", pos.txHash.slice(0, 14) + "...", pos.chainId, delta(pos.intentId, tradeT0));
    tradeT0.delete(pos.intentId);
  };

  const onResearchReq = (req: ResearchRequest): void => {
    researchT0.set(req.requestId, Date.now());
    log.agent("research", `request ${req.address?.slice(0, 12) ?? req.tokenName ?? "trending"}...`);
  };

  const onResearchRes = (res: ResearchResult): void => {
    if (!researchT0.has(res.requestId)) return;
    log.agent("research", `done safety=${res.safetyScore ?? "-"} price=$${res.priceUsd ?? "?"} ${delta(res.requestId, researchT0)}`);
    researchT0.delete(res.requestId);
  };

  bus.on("TRADE_REQUEST", onRequest);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("QUOTE_RESULT", onQuote);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("RESEARCH_REQUEST", onResearchReq);
  bus.on("RESEARCH_RESULT", onResearchRes);

  return () => {
    bus.off("TRADE_REQUEST", onRequest);
    bus.off("SAFETY_RESULT", onSafety);
    bus.off("QUOTE_RESULT", onQuote);
    bus.off("STRATEGY_DECISION", onStrategy);
    bus.off("TRADE_EXECUTED", onExecuted);
    bus.off("RESEARCH_REQUEST", onResearchReq);
    bus.off("RESEARCH_RESULT", onResearchRes);
  };
}
