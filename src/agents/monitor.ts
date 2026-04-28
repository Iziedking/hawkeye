/**
 * Monitor Agent
 * src/agents/monitor.ts
 *
 * Responsibilities:
 *   - Listen for TRADE_EXECUTED (payload = Position)
 *   - Spawn one price watcher per open position
 *   - Evaluate remainingExits (PartialExit[]) on every price tick
 *   - Emit EXECUTE_SELL (ExecuteSellPayload) when an exit target is hit
 *   - Emit POSITION_UPDATE on every tick so the dashboard stays live
 */

import bus from "../shared/event-bus";
import type {
  Position,
  ExitTarget,
  ExecuteSellPayload,
  PositionUpdate,
  ChainId,
} from "../shared/types";

// Constants

const POLL_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 5;

// State 

/** positionId → interval handle */
const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * positionId → live Position snapshot.
 * We mutate remainingExits as each partial exit fires.
 */
const positionRegistry = new Map<string, Position>();

// Price fetching 

/**
 * Fetch current USD price for a token via DexScreener MCP.
 * Token contract addresses are a single token so they satisfy the
 * "single word only" search rule from CONTRIBUTING.md.
 */
async function fetchPriceUsd(
  tokenAddress: string,
  chainId: ChainId
): Promise<number | null> {
  try {
    const result = await (globalThis as any).__mcp_dexscreener?.search_pairs({
      query: tokenAddress,
    });

    if (!result?.pairs?.length) return null;

    // Prefer a pair on the correct chain; fall back to the first result.
    const match =
      result.pairs.find(
        (p: any) => p.chainId?.toLowerCase() === chainId.toLowerCase()
      ) ?? result.pairs[0];

    const price = parseFloat(match?.priceUsd ?? "0");
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ─── Exit target evaluation ───────────────────────────────────────────────────

/**
 * Returns true when the current price satisfies an ExitTarget.
 *
 * multiplier — price has risen N× from entry.
 * price      — price has reached a specific USD level.
 * fdv/mc     — requires total supply (not in Position today).
 *              Logged as a warning and skipped until Strategy enriches
 *              Position with supply data.
 */
function evaluateTarget(
  target: ExitTarget,
  currentPriceUsd: number,
  entryPriceUsd: number
): boolean {
  switch (target.kind) {
    case "multiplier":
      return currentPriceUsd >= entryPriceUsd * target.value;

    case "price":
      return currentPriceUsd >= target.usd;

    case "fdv":
    case "marketcap":
      // Cannot evaluate without total supply.
      // Strategy Agent should enrich Position with totalSupply before this runs.
      console.warn(
        `[Monitor] ${target.kind} exit ($${target.usd}) skipped — ` +
          `total supply not available in Position yet`
      );
      return false;
  }
}

// Helpers
function emitPositionUpdate(
  positionId: string,
  priceUsd: number,
  entryPriceUsd: number
): void {
  const update: PositionUpdate = {
    positionId,
    priceUsd,
    pnlPct: ((priceUsd - entryPriceUsd) / entryPriceUsd) * 100,
    at: Date.now(),
  };
  bus.emit("POSITION_UPDATE", update);
}

function destroyWatcher(positionId: string): void {
  const handle = activeWatchers.get(positionId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeWatchers.delete(positionId);
  }
  positionRegistry.delete(positionId);
  console.log(`[Monitor] Watcher removed — positionId=${positionId}`);
}

// Core: spawn one price watcher per position 

function spawnPriceWatcher(position: Position): void {
  const { positionId, address, chainId, entryPriceUsd } = position;

  if (activeWatchers.has(positionId)) {
    console.warn(
      `[Monitor] Duplicate spawn blocked — positionId=${positionId}`
    );
    return;
  }

  console.log(
    `[Monitor] Spawning watcher — positionId=${positionId} ` +
      `address=${address} chainId=${chainId} ` +
      `exits=${position.remainingExits.length}`
  );

  let errorCount = 0;

  const handle = setInterval(async () => {
    const pos = positionRegistry.get(positionId);
    if (!pos) {
      destroyWatcher(positionId);
      return;
    }

    const priceUsd = await fetchPriceUsd(address, chainId);

    if (priceUsd === null) {
      errorCount++;
      console.warn(
        `[Monitor] Price fetch failed — positionId=${positionId} ` +
          `(${errorCount}/${MAX_CONSECUTIVE_ERRORS})`
      );
      return;
    }

    errorCount = 0;

    // Push live P&L to Gateway → dashboard every tick.
    emitPositionUpdate(positionId, priceUsd, entryPriceUsd);

    // ── Evaluate exits in order ────────────────────────────────────────────
    // Position.remainingExits is ordered by the user's intent.
    // Fire the first hit, remove it from the list, and stop evaluating
    // further exits this tick to avoid race conditions.

    const exits = pos.remainingExits;

    for (let i = 0; i < exits.length; i++) {
      const exit = exits[i];
      if (exit === undefined) continue;

      if (!evaluateTarget(exit.target, priceUsd, entryPriceUsd)) continue;

      console.log(
        `[Monitor] Exit triggered — positionId=${positionId} ` +
          `kind=${exit.target.kind} percent=${exit.percent}% price=$${priceUsd}`
      );

      const payload: ExecuteSellPayload = {
        positionId,
        fraction: exit.percent / 100, // PartialExit.percent (0-100) → fraction (0-1)
        triggeredBy: exit.target,     // ExitTarget — exactly as typed
        emittedAt: Date.now(),
      };

      bus.emit("EXECUTE_SELL", payload);

      // Consume the fired exit.
      pos.remainingExits = exits.filter((_, idx) => idx !== i);

      if (pos.remainingExits.length === 0) {
        console.log(
          `[Monitor] All exits consumed — positionId=${positionId}`
        );
        destroyWatcher(positionId);
      }

      return; // One exit per tick max.
    }
  }, POLL_INTERVAL_MS);

  activeWatchers.set(positionId, handle);
}

// Agent entry point 

export function startMonitorAgent(): void {
  console.log("[Monitor] Agent started");

  // TradeExecutedPayload = Position (see types.ts line: type TradeExecutedPayload = Position)
  bus.on("TRADE_EXECUTED", (position: Position) => {
    const { positionId, address, chainId } = position;

    console.log(
      `[Monitor] TRADE_EXECUTED — positionId=${positionId} ` +
        `address=${address} chainId=${chainId}`
    );

    if (activeWatchers.has(positionId)) {
      console.warn(
        `[Monitor] Already watching positionId=${positionId} — skipping duplicate`
      );
      return;
    }

    // Deep-clone so our mutations to remainingExits don't corrupt
    // other bus listeners that hold a reference to the same object.
    const snapshot: Position = {
      ...position,
      remainingExits: position.remainingExits.map((e) => ({ ...e })),
    };

    positionRegistry.set(positionId, snapshot);
    spawnPriceWatcher(snapshot);

    // Emit an immediate update at entry price so the dashboard shows
    // the position the moment it opens (pnlPct = 0).
    emitPositionUpdate(positionId, position.entryPriceUsd, position.entryPriceUsd);
  });

  // Defensive: if Execution Agent or Gateway closes a position through another
  // path (manual exit, liquidation), stop the watcher so we don't leak intervals.
  bus.on("EXECUTE_SELL", (payload: ExecuteSellPayload) => {
    if (!positionRegistry.has(payload.positionId)) return;

    // fraction >= 1 means full exit — watcher is no longer needed.
    if (payload.fraction >= 1) {
      destroyWatcher(payload.positionId);
    }
  });
}


export function getActiveWatcherCount(): number {
  return activeWatchers.size;
}

export function getWatchedPositions(): Position[] {
  return Array.from(positionRegistry.values());
}