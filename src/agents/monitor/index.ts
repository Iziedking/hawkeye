import bus from "../../shared/event-bus";
import type {
  Position,
  ExitTarget,
  ExecuteSellPayload,
  PositionUpdate,
  ChainId,
} from "../../shared/types";

const POLL_INTERVAL_MS = 5_000;
const MAX_ERRORS = 5;
const TRAILING_STOP_PCT = 20;
const PNL_MILESTONES = [50, 100, 200, 500];

interface PairData {
  priceUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
}

interface TrackedPosition {
  position: Position;
  peakPriceUsd: number;
  errorCount: number;
  alertedMilestones: Set<number>;
}

interface DexPair {
  chainId: string;
  priceUsd: string;
  fdv?: string | null;
  marketCap?: string | null;
}

interface DexScreenerMcp {
  search_pairs(args: { query: string }): Promise<{ pairs: DexPair[] }>;
}

const tracked = new Map<string, TrackedPosition>();
const watchers = new Map<string, ReturnType<typeof setInterval>>();

// Tracks sells we emitted so the EXECUTE_SELL listener doesn't
// double-remove watchers we already cleaned up internally.
const selfEmittedSells = new Set<string>();

function getDexScreener(): DexScreenerMcp | null {
  return (globalThis as Record<string, unknown>)["__mcp_dexscreener"] as DexScreenerMcp ?? null;
}

async function fetchPairData(address: string, chainId: ChainId): Promise<PairData | null> {
  try {
    const mcp = getDexScreener();
    if (!mcp) return null;

    const { pairs } = await mcp.search_pairs({ query: address });
    if (!pairs.length) return null;

    const match = pairs.find((p) => p.chainId.toLowerCase() === chainId.toLowerCase()) ?? pairs[0];
    if (!match) return null;

    const priceUsd = parseFloat(match.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    return {
      priceUsd,
      fdvUsd: match.fdv != null ? parseFloat(match.fdv) : null,
      marketCapUsd: match.marketCap != null ? parseFloat(match.marketCap) : null,
    };
  } catch {
    return null;
  }
}

function evaluateTarget(target: ExitTarget, data: PairData, entryPriceUsd: number): boolean {
  switch (target.kind) {
    case "multiplier": return data.priceUsd >= entryPriceUsd * target.value;
    case "price":      return data.priceUsd >= target.usd;
    case "fdv":        return data.fdvUsd !== null && data.fdvUsd >= target.usd;
    case "marketcap":  return data.marketCapUsd !== null && data.marketCapUsd >= target.usd;
  }
}

function emitUpdate(positionId: string, priceUsd: number, entryPriceUsd: number): void {
  const update: PositionUpdate = {
    positionId,
    priceUsd,
    pnlPct: ((priceUsd - entryPriceUsd) / entryPriceUsd) * 100,
    at: Date.now(),
  };
  bus.emit("POSITION_UPDATE", update);
}

function emitSell(positionId: string, fraction: number, triggeredBy: ExitTarget): void {
  selfEmittedSells.add(positionId);
  const payload: ExecuteSellPayload = { positionId, fraction, triggeredBy, emittedAt: Date.now() };
  bus.emit("EXECUTE_SELL", payload);
}

function checkMilestones(state: TrackedPosition, priceUsd: number): void {
  const { position, alertedMilestones } = state;
  const pnlPct = ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

  for (const milestone of PNL_MILESTONES) {
    if (pnlPct < milestone || alertedMilestones.has(milestone)) continue;
    alertedMilestones.add(milestone);
    console.log(`[Monitor] +${milestone}% — ${position.positionId} @ $${priceUsd.toFixed(4)}`);
    emitUpdate(position.positionId, priceUsd, position.entryPriceUsd);
  }
}

function removeWatcher(positionId: string): void {
  const handle = watchers.get(positionId);
  if (handle !== undefined) clearInterval(handle);
  watchers.delete(positionId);
  tracked.delete(positionId);
  selfEmittedSells.delete(positionId);
  console.log(`[Monitor] closed — ${positionId}`);
}

function spawnWatcher(position: Position): void {
  const { positionId, address, chainId, entryPriceUsd } = position;

  if (watchers.has(positionId)) {
    console.warn(`[Monitor] already watching — ${positionId}`);
    return;
  }

  console.log(`[Monitor] watching ${address} on ${chainId} — ${positionId}`);

  const state: TrackedPosition = {
    position,
    peakPriceUsd: entryPriceUsd,
    errorCount: 0,
    alertedMilestones: new Set(),
  };
  tracked.set(positionId, state);

  const handle = setInterval(async () => {
    const s = tracked.get(positionId);
    if (!s) { removeWatcher(positionId); return; }

    const data = await fetchPairData(address, chainId);
    if (data === null) {
      s.errorCount++;
      if (s.errorCount === MAX_ERRORS) console.warn(`[Monitor] price feed lost — ${positionId}`);
      return;
    }
    s.errorCount = 0;

    const { priceUsd } = data;
    if (priceUsd > s.peakPriceUsd) s.peakPriceUsd = priceUsd;

    emitUpdate(positionId, priceUsd, entryPriceUsd);
    checkMilestones(s, priceUsd);

    // Trailing stop: fire if price pulls back more than TRAILING_STOP_PCT from peak.
    const trailingFloor = s.peakPriceUsd * (1 - TRAILING_STOP_PCT / 100);
    if (s.peakPriceUsd > entryPriceUsd && priceUsd <= trailingFloor) {
      console.log(`[Monitor] trailing stop — ${positionId} peak=$${s.peakPriceUsd.toFixed(4)} now=$${priceUsd.toFixed(4)}`);
      emitSell(positionId, 1, { kind: "price", usd: priceUsd });
      removeWatcher(positionId);
      return;
    }

    // Evaluate exits in order. Fire one per tick to avoid race conditions.
    const exits = s.position.remainingExits;
    for (let i = 0; i < exits.length; i++) {
      const exit = exits[i];
      if (exit === undefined || !evaluateTarget(exit.target, data, entryPriceUsd)) continue;

      console.log(`[Monitor] exit — ${positionId} ${exit.target.kind} ${exit.percent}% @ $${priceUsd.toFixed(4)}`);
      emitSell(positionId, exit.percent / 100, exit.target);
      s.position.remainingExits = exits.filter((_, idx) => idx !== i);
      if (s.position.remainingExits.length === 0) removeWatcher(positionId);
      return;
    }
  }, POLL_INTERVAL_MS);

  watchers.set(positionId, handle);
  emitUpdate(positionId, entryPriceUsd, entryPriceUsd);
}

export function startMonitorAgent(): { stop(): void } {
  console.log("[Monitor] started");

  bus.on("TRADE_EXECUTED", (position: Position) => {
    if (watchers.has(position.positionId)) {
      console.warn(`[Monitor] duplicate TRADE_EXECUTED — ${position.positionId}`);
      return;
    }
    spawnWatcher({
      ...position,
      remainingExits: position.remainingExits.map((e) => ({ ...e })),
    });
  });

  bus.on("EXECUTE_SELL", (payload: ExecuteSellPayload) => {
    // Only handle external closes (e.g. manual exit via Gateway).
    // Skips sells we emitted — already cleaned up inside the watcher.
    if (payload.fraction >= 1 && !selfEmittedSells.has(payload.positionId)) {
      removeWatcher(payload.positionId);
    }
  });

  return {
    stop() {
      for (const id of [...watchers.keys()]) removeWatcher(id);
      console.log("[Monitor] stopped");
    },
  };
}

export function getActiveWatcherCount(): number { return watchers.size; }
export function getWatchedPositions(): Position[] {
  return Array.from(tracked.values()).map((s) => s.position);
}