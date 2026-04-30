/**
 * Copy Trade Agent
 * Watches wallets for swap activity and emits COPY_TRADE_REQUEST → Safety pipeline.
 * Deduplicates by txHash and pair window. Reconnects with exponential back-off.
 */

import { bus } from "../../shared/event-bus";
import type {
  TradeIntent,
  ChainClass,
  ChainId,
  AmountUnit,
  WatchedWallet,
} from "../../shared/types";

interface RawSwapEvent {
  txHash: string;
  makerAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  type: "buy" | "sell";
  volumeUsd: number;
  chainId: ChainId;
}

interface WsEntry {
  ws: WebSocket;
  wallet: WatchedWallet;
  reconnectAttempts: number;
}

// Constants
const SHORT_DEDUP_WINDOW_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** DexScreener live pairs WebSocket — top pairs by 24h volume. */
const DEXSCREENER_WS_URL = "wss://io.dexscreener.com/dex/screener/pairs/h24/1";

// ─── State
const watchedWallets = new Map<string, WatchedWallet>(); // key: address (lowercase)
const wsConnections = new Map<string, WsEntry>(); // key: address (lowercase)
const recentEmits = new Map<string, number>(); // key: dedup key, value: timestamp ms

//  Deduplication

function makeDedupKey(
  walletAddress: string,
  baseTokenAddress: string,
  quoteTokenAddress: string,
): string {
  return [
    walletAddress.toLowerCase(),
    baseTokenAddress.toLowerCase(),
    quoteTokenAddress.toLowerCase(),
  ].join("-");
}

function isDuplicate(key: string): boolean {
  const ts = recentEmits.get(key);
  return ts !== undefined && Date.now() - ts < SHORT_DEDUP_WINDOW_MS;
}

function markSeen(key: string): void {
  recentEmits.set(key, Date.now());
  // Prune stale entries — runs O(n) but the map stays tiny in practice.
  for (const [k, ts] of recentEmits) {
    if (Date.now() - ts > SHORT_DEDUP_WINDOW_MS * 2) recentEmits.delete(k);
  }
}

// Chain resolution
/**
 * Map a DexScreener chainId string to our ChainClass ("evm" | "solana").
 */
function chainClassFromId(chainId: ChainId): ChainClass {
  return chainId === "solana" ? "solana" : "evm";
}

// Build TradeIntent from a raw swap event

/**
 * COPY_TRADE_REQUEST carries a TradeIntent derived from swap data:
 * - address: target token (toToken for buys, fromToken for sells)
 * - amount: { value: volumeUsd, unit: "USD" }
 * - exits: [] (default strategy applies)
 * - urgency: "NORMAL"
 * - userId: "copy-trade:{walletLabel}" (for routing)
 *
 * Fields may be enriched or overridden by Strategy Agent and Gateway.
 */

function buildTradeIntent(swap: RawSwapEvent, wallet: WatchedWallet): TradeIntent {
  const chain = chainClassFromId(swap.chainId);

  // For a BUY the user wants the base token; for a SELL they're exiting it.
  // We model copy-trade as always replicating the BUY side.
  const tokenAddress = swap.type === "buy" ? swap.baseToken.address : swap.quoteToken.address;

  const amountUnit: AmountUnit = "USD";

  return {
    intentId: `copy-${swap.txHash}-${Date.now()}`,
    userId: `copy-trade:${wallet.label ?? wallet.address}`,
    channel: "webchat",
    address: tokenAddress,
    chain,
    amount: {
      value: swap.volumeUsd,
      unit: amountUnit,
    },
    exits: [], // Strategy Agent applies user default exits
    urgency: "NORMAL",
    rawText:
      `Copy trade from ${wallet.label ?? wallet.address}: ` +
      `${swap.type.toUpperCase()} ${swap.baseToken.symbol}/${swap.quoteToken.symbol} ` +
      `$${swap.volumeUsd.toFixed(2)} on ${swap.chainId}`,
    createdAt: Date.now(),
  };
}

//  Swap event handling

async function handleSwapEvent(wallet: WatchedWallet, swap: RawSwapEvent): Promise<void> {
  //  Dedup by txHash
  if (isDuplicate(swap.txHash)) {
    console.log(`[CopyTrade] Duplicate txHash ${swap.txHash} — skipped`);
    return;
  }
  markSeen(swap.txHash);

  //  Dedup by pair within the short window
  const pairKey = makeDedupKey(wallet.address, swap.baseToken.address, swap.quoteToken.address);
  if (isDuplicate(pairKey)) {
    console.log(
      `[CopyTrade] Duplicate pair ${swap.baseToken.symbol}/${swap.quoteToken.symbol} ` +
        `within ${SHORT_DEDUP_WINDOW_MS / 1000}s window — skipped`,
    );
    return;
  }
  markSeen(pairKey);

  // Only replicate buys by default
  // Sells are noisier and harder to size correctly without knowing the
  // entry amount. We could add a user config toggle for this in the future.
  if (swap.type !== "buy") {
    console.log(
      `[CopyTrade] Sell detected from ${wallet.label ?? wallet.address} — skipping (buys only)`,
    );
    return;
  }

  const intent = buildTradeIntent(swap, wallet);

  console.log(
    `[CopyTrade] COPY_TRADE_REQUEST emitting — ` +
      `wallet=${wallet.label ?? wallet.address} ` +
      `token=${swap.baseToken.symbol} $${swap.volumeUsd.toFixed(2)} ` +
      `tx=${swap.txHash}`,
  );

  // Per CONTRIBUTING.md event table: listener is Safety Agent.
  bus.emit("COPY_TRADE_REQUEST", intent);
}

//  WebSocket message parsing

/**
 * DexScreener WS pushes pair activity updates.
 * We filter for transactions initiated by our watched wallet (maker field).
 */
function parseWsMessage(raw: string, wallet: WatchedWallet): RawSwapEvent | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null || (msg as any).type !== "pair_update") {
      return null;
    }

    const txns: any[] = (msg as any).data?.txns ?? [];
    const walletAddr = wallet.address.toLowerCase();

    const swapTx = txns.find(
      (tx: any) =>
        (tx.type === "buy" || tx.type === "sell") &&
        typeof tx.maker === "string" &&
        tx.maker.toLowerCase() === walletAddr,
    );

    if (!swapTx) return null;

    const pairData = (msg as any).data;

    return {
      txHash: swapTx.txHash ?? `synthetic-${Date.now()}`,
      makerAddress: swapTx.maker as string,
      baseToken: {
        address: pairData?.baseToken?.address ?? "",
        symbol: pairData?.baseToken?.symbol ?? "UNKNOWN",
      },
      quoteToken: {
        address: pairData?.quoteToken?.address ?? "",
        symbol: pairData?.quoteToken?.symbol ?? "UNKNOWN",
      },
      type: swapTx.type as "buy" | "sell",
      volumeUsd: parseFloat(swapTx.volumeUsd ?? "0"),
      chainId: pairData?.chainId as ChainId,
    };
  } catch {
    return null;
  }
}

//  WebSocket lifecycle

function connectWallet(wallet: WatchedWallet): void {
  const addr = wallet.address.toLowerCase();
  const existing = wsConnections.get(addr);

  if (existing?.ws.readyState === WebSocket.OPEN) {
    console.log(`[CopyTrade] WS already open for ${addr}`);
    return;
  }

  const attempts = existing?.reconnectAttempts ?? 0;
  const backoffMs = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);

  const doConnect = (): void => {
    console.log(
      `[CopyTrade] Opening WS for ${wallet.label ?? addr} ` + `(attempt ${attempts + 1})`,
    );

    const ws = new WebSocket(DEXSCREENER_WS_URL);
    const entry: WsEntry = { ws, wallet, reconnectAttempts: attempts + 1 };
    wsConnections.set(addr, entry);

    ws.addEventListener("open", () => {
      console.log(`[CopyTrade] WS open — ${addr}`);
      entry.reconnectAttempts = 0; // Reset back-off on successful connect.
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : String(evt.data);
      const swap = parseWsMessage(raw, wallet);
      if (swap !== null) {
        void handleSwapEvent(wallet, swap);
      }
    });

    ws.addEventListener("error", (err) => {
      console.error(`[CopyTrade] WS error — ${addr}:`, err);
    });

    ws.addEventListener("close", (evt) => {
      console.warn(
        `[CopyTrade] WS closed — ${addr} code=${evt.code} ` + `reconnecting in ${backoffMs}ms`,
      );
      if (watchedWallets.has(addr)) {
        setTimeout(() => connectWallet(wallet), backoffMs);
      }
    });
  };

  if (attempts === 0) {
    doConnect();
  } else {
    setTimeout(doConnect, backoffMs);
  }
}

function disconnectWallet(address: string): void {
  const addr = address.toLowerCase();
  const entry = wsConnections.get(addr);
  if (entry) {
    entry.ws.close(1000, "Wallet removed from watch list");
    wsConnections.delete(addr);
  }
  watchedWallets.delete(addr);
  console.log(`[CopyTrade] Wallet removed — ${addr}`);
}

//  Agent entry point

export function startCopyTradeAgent(): { stop(): void } {
  console.log("[copy-trade] agent started");

  const onAddWallet = (wallet: WatchedWallet): void => {
    const addr = wallet.address.toLowerCase();
    if (!watchedWallets.has(addr)) {
      watchedWallets.set(addr, wallet);
      connectWallet(wallet);
      console.log(`[copy-trade] wallet added via bus: ${addr}`);
    }
  };

  const onRemoveWallet = (address: string): void => {
    disconnectWallet(address);
  };

  bus.on("ADD_WATCHED_WALLET", onAddWallet);
  bus.on("REMOVE_WATCHED_WALLET", onRemoveWallet);

  return {
    stop(): void {
      bus.off("ADD_WATCHED_WALLET", onAddWallet);
      bus.off("REMOVE_WATCHED_WALLET", onRemoveWallet);
      for (const addr of watchedWallets.keys()) {
        disconnectWallet(addr);
      }
    },
  };
}

// Diagnostics

export function getWatchedWalletCount(): number {
  return watchedWallets.size;
}

export function getWatchedWalletAddresses(): string[] {
  return Array.from(watchedWallets.keys());
}

export function addWalletDirectly(wallet: WatchedWallet): void {
  const addr = wallet.address.toLowerCase();
  if (!watchedWallets.has(addr)) {
    watchedWallets.set(addr, wallet);
    connectWallet(wallet);
  }
}
