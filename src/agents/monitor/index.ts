import { bus } from "../../shared/event-bus";
import type {
  Position,
  PositionUpdate,
  ExecuteSellPayload,
  ExitTarget,
  ChainId,
} from "../../shared/types";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";

export type MonitorDeps = {
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  trailingStopPct?: number;
};

export type MonitorHandle = {
  stop: () => void;
  tracked: Map<string, TrackedPosition>;
};

type TrackedPosition = {
  position: Position;
  peakPriceUsd: number;
  consecutiveErrors: number;
  timer: ReturnType<typeof setInterval> | null;
};

const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_TRAILING_STOP_PCT = 30;

export function startMonitorAgent(deps: MonitorDeps = {}): MonitorHandle {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const pollMs = deps.pollIntervalMs ?? 10_000;
  const trailingStopPct = deps.trailingStopPct ?? DEFAULT_TRAILING_STOP_PCT;

  const tracked = new Map<string, TrackedPosition>();

  function onTradeExecuted(pos: Position): void {
    if (tracked.has(pos.positionId)) return;
    if (pos.remainingExits.length === 0) {
      console.log("[monitor] skipping position with no exit targets:", pos.positionId);
      return;
    }

    const tp: TrackedPosition = {
      position: pos,
      peakPriceUsd: pos.entryPriceUsd,
      consecutiveErrors: 0,
      timer: null,
    };

    tracked.set(pos.positionId, tp);

    tp.timer = setInterval(() => {
      void pollPrice(tp);
    }, pollMs);

    console.log(
      `[monitor] tracking ${pos.positionId} entry=$${pos.entryPriceUsd} exits=${pos.remainingExits.length}`,
    );
  }

  async function pollPrice(tp: TrackedPosition): Promise<void> {
    const pos = tp.position;

    try {
      const price = await fetchPrice(pos.address, pos.chainId, fetchFn);

      if (price === null) {
        tp.consecutiveErrors++;
        if (tp.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.warn(
            `[monitor] ${MAX_CONSECUTIVE_ERRORS} consecutive fetch failures for ${pos.positionId}, removing watcher`,
          );
          stopTracking(pos.positionId);
        }
        return;
      }

      tp.consecutiveErrors = 0;

      if (price > tp.peakPriceUsd) tp.peakPriceUsd = price;

      const multiplier = price / pos.entryPriceUsd;
      const pnlPct = (multiplier - 1) * 100;

      const update: PositionUpdate = {
        positionId: pos.positionId,
        priceUsd: price,
        pnlPct,
        at: Date.now(),
      };
      bus.emit("POSITION_UPDATE", update);

      if (checkTrailingStop(tp, price)) return;

      checkExits(tp, price, multiplier);
    } catch (err) {
      tp.consecutiveErrors++;
      console.error("[monitor] price fetch error for", pos.positionId, err);
      if (tp.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn(`[monitor] too many errors, removing watcher for ${pos.positionId}`);
        stopTracking(pos.positionId);
      }
    }
  }

  function checkTrailingStop(tp: TrackedPosition, currentPrice: number): boolean {
    if (tp.peakPriceUsd <= tp.position.entryPriceUsd) return false;

    const dropFromPeak = ((tp.peakPriceUsd - currentPrice) / tp.peakPriceUsd) * 100;

    if (dropFromPeak >= trailingStopPct) {
      console.log(
        `[monitor] trailing stop triggered for ${tp.position.positionId}: ` +
          `peak=$${tp.peakPriceUsd.toFixed(6)} current=$${currentPrice.toFixed(6)} ` +
          `drop=${dropFromPeak.toFixed(1)}%`,
      );

      const payload: ExecuteSellPayload = {
        positionId: tp.position.positionId,
        fraction: 1.0,
        triggeredBy: { kind: "multiplier", value: 0 },
        emittedAt: Date.now(),
      };

      bus.emit("EXECUTE_SELL", payload);
      stopTracking(tp.position.positionId);
      return true;
    }

    return false;
  }

  function checkExits(tp: TrackedPosition, price: number, multiplier: number): void {
    const pos = tp.position;
    const toRemove: number[] = [];

    for (let i = 0; i < pos.remainingExits.length; i++) {
      const exit = pos.remainingExits[i];
      if (!exit) continue;

      if (isExitHit(exit.target, price, multiplier)) {
        const payload: ExecuteSellPayload = {
          positionId: pos.positionId,
          fraction: exit.percent / 100,
          triggeredBy: exit.target,
          emittedAt: Date.now(),
        };

        bus.emit("EXECUTE_SELL", payload);
        console.log(
          `[monitor] exit ${exitLabel(exit.target)} hit for ${pos.positionId} ` +
            `at $${price.toFixed(6)} (${exit.percent}% sell)`,
        );
        toRemove.push(i);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      pos.remainingExits.splice(toRemove[i]!, 1);
    }

    if (pos.remainingExits.length === 0) {
      stopTracking(pos.positionId);
    }
  }

  function onPartialSellCompleted(payload: ExecuteSellPayload): void {
    const tp = tracked.get(payload.positionId);
    if (!tp) return;

    if (payload.fraction >= 1) {
      stopTracking(payload.positionId);
      console.log(`[monitor] full sell completed, stopped tracking ${payload.positionId}`);
    }
  }

  function stopTracking(positionId: string): void {
    const tp = tracked.get(positionId);
    if (!tp) return;
    if (tp.timer) clearInterval(tp.timer);
    tracked.delete(positionId);
    console.log("[monitor] stopped tracking", positionId);
  }

  bus.on("TRADE_EXECUTED", onTradeExecuted);
  bus.on("EXECUTE_SELL", onPartialSellCompleted);

  console.log("[monitor] agent started, poll interval", pollMs + "ms");

  return {
    stop() {
      bus.off("TRADE_EXECUTED", onTradeExecuted);
      bus.off("EXECUTE_SELL", onPartialSellCompleted);
      for (const tp of tracked.values()) {
        if (tp.timer) clearInterval(tp.timer);
      }
      tracked.clear();
    },
    tracked,
  };
}

function isExitHit(target: ExitTarget, price: number, multiplier: number): boolean {
  switch (target.kind) {
    case "multiplier":
      return multiplier >= target.value;
    case "price":
      return price >= target.usd;
    case "fdv":
    case "marketcap":
      return false;
    default:
      return false;
  }
}

function exitLabel(target: ExitTarget): string {
  switch (target.kind) {
    case "multiplier":
      return target.value + "x";
    case "price":
      return "$" + target.usd;
    case "fdv":
      return "FDV $" + target.usd;
    case "marketcap":
      return "MC $" + target.usd;
  }
}

async function fetchPrice(
  address: string,
  chainId: ChainId,
  fetchFn: typeof fetch,
): Promise<number | null> {
  const res = await fetchFn(`${DEXSCREENER_API}/${address}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;

  const data: any = await res.json();
  const pairs = data.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  const match = pairs.find((p: any) => p.chainId === chainId) ?? pairs[0];
  const price = parseFloat(match.priceUsd);
  return isNaN(price) ? null : price;
}

export function getActiveWatcherCount(): number {
  return 0;
}

export function getWatchedPositions(): Position[] {
  return [];
}
