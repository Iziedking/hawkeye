import { bus } from "../../shared/event-bus";
import type {
  SafetyReport,
  StrategyDecision,
  TradeExecutedPayload,
  ResearchResult,
  AlphaFoundPayload,
  TradeIntent,
} from "../../shared/types";
import { OgStorageClient } from "./storage";
import { RegistryClient } from "./registry-client";

type AuditDeps = {
  storage: OgStorageClient | null;
  registry: RegistryClient | null;
};

function writeStorage(storage: OgStorageClient, key: string, payload: unknown): void {
  if (storage.circuitOpen) return;
  storage.writeJson(key, payload).then(
    (res) => console.log(`[audit] 0G Storage: ${key} → root=${res.rootHash}`),
    (err) => {
      if (!storage.circuitOpen) {
        console.error(`[audit] 0G Storage write failed (${key}):`, (err as Error).message);
      }
    },
  );
}

function writeChain(registry: RegistryClient, label: string, fn: () => Promise<string>): void {
  fn().then(
    (hash) => console.log(`[audit] 0G Chain: ${label} → tx=${hash}`),
    (err) => console.error(`[audit] 0G Chain write failed (${label}):`, err),
  );
}

const safetyByIntent = new Map<string, SafetyReport>();

export function startAuditTrail(deps: AuditDeps): () => void {
  const { storage, registry } = deps;

  if (!storage && !registry) {
    console.warn("[audit] No 0G clients available — audit trail disabled");
    return () => {};
  }

  console.log(
    `[audit] trail active — storage=${storage ? "on" : "off"} registry=${registry ? "on" : "off"}`,
  );

  const onTradeRequest = (intent: TradeIntent): void => {
    if (storage) {
      writeStorage(storage, `intent:${intent.intentId}`, intent);
    }
    if (registry) {
      writeChain(registry, `storeIntent:${intent.intentId}`, () =>
        registry.storeIntent(intent.intentId, {
          address: intent.address,
          chain: intent.chain,
          amount: intent.amount,
          urgency: intent.urgency,
          at: intent.createdAt,
        }),
      );
    }
  };

  const onSafetyResult = (report: SafetyReport): void => {
    safetyByIntent.set(report.intentId, report);
    if (storage) {
      writeStorage(storage, `safety:${report.intentId}`, {
        intentId: report.intentId,
        address: report.address,
        chainId: report.chainId,
        score: report.score,
        flags: report.flags,
        sources: report.sources.map((s) => ({ provider: s.provider, ok: s.ok })),
        at: report.completedAt,
      });
    }
  };

  const onStrategyDecision = (d: StrategyDecision): void => {
    if (storage) {
      writeStorage(storage, `strategy:${d.intentId}`, d);
    }
  };

  const onTradeExecuted = (pos: TradeExecutedPayload): void => {
    if (storage) {
      writeStorage(storage, `execution:${pos.intentId}`, {
        intentId: pos.intentId,
        positionId: pos.positionId,
        address: pos.address,
        chainId: pos.chainId,
        txHash: pos.txHash,
        entryPriceUsd: pos.entryPriceUsd,
        filled: pos.filled,
        at: pos.openedAt,
      });
    }
    if (registry) {
      const safety = safetyByIntent.get(pos.intentId);
      const score = safety?.score ?? 0;
      writeChain(registry, `logTrade:${pos.intentId}`, () =>
        registry.logTrade(pos.intentId, pos.address, pos.chainId, score, "EXECUTED"),
      );
      safetyByIntent.delete(pos.intentId);
    }
  };

  const onResearchResult = (res: ResearchResult): void => {
    if (storage) {
      writeStorage(storage, `research:${res.requestId}`, {
        requestId: res.requestId,
        address: res.address,
        chain: res.chain,
        safetyScore: res.safetyScore,
        priceUsd: res.priceUsd,
        liquidityUsd: res.liquidityUsd,
        flags: res.flags,
        at: res.completedAt,
      });
    }
  };

  const onAlphaFound = (alpha: AlphaFoundPayload): void => {
    if (storage) {
      writeStorage(storage, `alpha:${alpha.address}:${alpha.foundAt}`, alpha);
    }
  };

  bus.on("TRADE_REQUEST", onTradeRequest);
  bus.on("SAFETY_RESULT", onSafetyResult);
  bus.on("STRATEGY_DECISION", onStrategyDecision);
  bus.on("TRADE_EXECUTED", onTradeExecuted);
  bus.on("RESEARCH_RESULT", onResearchResult);
  bus.on("ALPHA_FOUND", onAlphaFound);

  return () => {
    bus.off("TRADE_REQUEST", onTradeRequest);
    bus.off("SAFETY_RESULT", onSafetyResult);
    bus.off("STRATEGY_DECISION", onStrategyDecision);
    bus.off("TRADE_EXECUTED", onTradeExecuted);
    bus.off("RESEARCH_RESULT", onResearchResult);
    bus.off("ALPHA_FOUND", onAlphaFound);
    safetyByIntent.clear();
  };
}
