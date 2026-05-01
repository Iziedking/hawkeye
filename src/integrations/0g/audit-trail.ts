import { bus } from "../../shared/event-bus";
import { log } from "../../shared/logger";
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

let writeQueue: Promise<void> = Promise.resolve();

function writeStorage(storage: OgStorageClient, key: string, payload: unknown): void {
  if (storage.circuitOpen) return;
  writeQueue = writeQueue.then(async () => {
    try {
      const res = await storage.writeJson(key, payload);
      log.og("storage", `${key} root=${res.rootHash.slice(0, 12)}...`);
    } catch (err) {
      if (!storage.circuitOpen) {
        const msg = (err as Error).message ?? "";
        log.warn(`0G storage write failed (${key}): ${msg.slice(0, 80)}`);
      }
    }
  });
}

let chainQueue: Promise<void> = Promise.resolve();

function writeChain(registry: RegistryClient, label: string, fn: () => Promise<string>): void {
  chainQueue = chainQueue.then(async () => {
    try {
      const hash = await fn();
      log.og("chain", `${label} tx=${hash.slice(0, 14)}...`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.warn(`0G chain write failed (${label}): ${msg.slice(0, 80)}`);
    }
  });
}

const safetyByIntent = new Map<string, SafetyReport>();

export function startAuditTrail(deps: AuditDeps): () => void {
  const { storage, registry } = deps;

  if (!storage && !registry) {
    log.warn("No 0G clients available, audit trail disabled");
    return () => {};
  }

  log.og("storage", `audit trail active storage=${storage ? "on" : "off"} registry=${registry ? "on" : "off"}`);

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
