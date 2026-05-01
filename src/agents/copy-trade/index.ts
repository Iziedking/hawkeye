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

const SHORT_DEDUP_WINDOW_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MIN_COPY_VOLUME_USD = 10;
const MAX_COPY_VOLUME_USD = 500;

const DEXSCREENER_WS_URL = "wss://io.dexscreener.com/dex/screener/pairs/h24/1";

const watchedWallets = new Map<string, WatchedWallet>();
const wsConnections = new Map<string, WsEntry>();
const recentEmits = new Map<string, number>();

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
  for (const [k, ts] of recentEmits) {
    if (Date.now() - ts > SHORT_DEDUP_WINDOW_MS * 2) recentEmits.delete(k);
  }
}

function chainClassFromId(chainId: ChainId): ChainClass {
  return chainId === "solana" ? "solana" : "evm";
}

function buildTradeIntent(swap: RawSwapEvent, wallet: WatchedWallet): TradeIntent {
  const chain = chainClassFromId(swap.chainId);
  const tokenAddress = swap.type === "buy" ? swap.baseToken.address : swap.quoteToken.address;
  const side = swap.type === "buy" ? "buy" as const : "sell" as const;

  const cappedVolume = Math.min(swap.volumeUsd, MAX_COPY_VOLUME_USD);
  const amountUnit: AmountUnit = "USD";

  return {
    intentId: `copy-${swap.txHash}-${Date.now()}`,
    userId: `copy-trade:${wallet.label ?? wallet.address}`,
    channel: "webchat",
    address: tokenAddress,
    chain,
    amount: {
      value: cappedVolume,
      unit: amountUnit,
    },
    exits: [],
    urgency: "NORMAL",
    side,
    rawText:
      `Copy trade from ${wallet.label ?? wallet.address}: ` +
      `${swap.type.toUpperCase()} ${swap.baseToken.symbol}/${swap.quoteToken.symbol} ` +
      `$${swap.volumeUsd.toFixed(2)} on ${swap.chainId}`,
    createdAt: Date.now(),
  };
}

async function handleSwapEvent(wallet: WatchedWallet, swap: RawSwapEvent): Promise<void> {
  if (isDuplicate(swap.txHash)) {
    console.log(`[copy-trade] duplicate txHash ${swap.txHash}, skipped`);
    return;
  }
  markSeen(swap.txHash);

  const pairKey = makeDedupKey(wallet.address, swap.baseToken.address, swap.quoteToken.address);
  if (isDuplicate(pairKey)) {
    console.log(
      `[copy-trade] duplicate pair ${swap.baseToken.symbol}/${swap.quoteToken.symbol} within window, skipped`,
    );
    return;
  }
  markSeen(pairKey);

  if (swap.volumeUsd < MIN_COPY_VOLUME_USD) {
    console.log(
      `[copy-trade] volume $${swap.volumeUsd.toFixed(2)} below minimum $${MIN_COPY_VOLUME_USD}, skipped`,
    );
    return;
  }

  if (swap.type !== "buy") {
    console.log(
      `[copy-trade] sell from ${wallet.label ?? wallet.address} on ${swap.baseToken.symbol}, skipped (buys only)`,
    );
    return;
  }

  const intent = buildTradeIntent(swap, wallet);

  console.log(
    `[copy-trade] emitting COPY_TRADE_REQUEST: wallet=${wallet.label ?? wallet.address} ` +
      `token=${swap.baseToken.symbol} $${swap.volumeUsd.toFixed(2)} tx=${swap.txHash}`,
  );

  bus.emit("COPY_TRADE_REQUEST", intent);

  bus.emit("WALLET_ACTIVITY" as any, {
    walletAddress: wallet.address,
    walletLabel: wallet.label ?? wallet.address,
    action: swap.type,
    tokenSymbol: swap.baseToken.symbol,
    tokenAddress: swap.baseToken.address,
    volumeUsd: swap.volumeUsd,
    chainId: swap.chainId,
    txHash: swap.txHash,
    at: Date.now(),
  });
}

function parseWsMessage(raw: string, wallet: WatchedWallet): RawSwapEvent | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null) return null;
    const rec = msg as Record<string, unknown>;
    if (rec.type !== "pair_update") return null;

    const data = rec.data as Record<string, unknown> | undefined;
    const txns = (Array.isArray(data?.txns) ? data.txns : []) as Record<string, unknown>[];
    const walletAddr = wallet.address.toLowerCase();

    const swapTx = txns.find(
      (tx) =>
        (tx.type === "buy" || tx.type === "sell") &&
        typeof tx.maker === "string" &&
        tx.maker.toLowerCase() === walletAddr,
    );

    if (!swapTx) return null;

    const baseToken = data?.baseToken as Record<string, unknown> | undefined;
    const quoteToken = data?.quoteToken as Record<string, unknown> | undefined;

    return {
      txHash: (swapTx.txHash as string) ?? `synthetic-${Date.now()}`,
      makerAddress: swapTx.maker as string,
      baseToken: {
        address: (baseToken?.address as string) ?? "",
        symbol: (baseToken?.symbol as string) ?? "UNKNOWN",
      },
      quoteToken: {
        address: (quoteToken?.address as string) ?? "",
        symbol: (quoteToken?.symbol as string) ?? "UNKNOWN",
      },
      type: swapTx.type as "buy" | "sell",
      volumeUsd: parseFloat((swapTx.volumeUsd as string) ?? "0"),
      chainId: data?.chainId as ChainId,
    };
  } catch {
    return null;
  }
}

function connectWallet(wallet: WatchedWallet): void {
  const addr = wallet.address.toLowerCase();
  const existing = wsConnections.get(addr);

  if (existing?.ws.readyState === WebSocket.OPEN) {
    console.log(`[copy-trade] WS already open for ${addr}`);
    return;
  }

  const attempts = existing?.reconnectAttempts ?? 0;
  const backoffMs = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);

  const doConnect = (): void => {
    console.log(
      `[copy-trade] opening WS for ${wallet.label ?? addr} (attempt ${attempts + 1})`,
    );

    const ws = new WebSocket(DEXSCREENER_WS_URL);
    const entry: WsEntry = { ws, wallet, reconnectAttempts: attempts + 1 };
    wsConnections.set(addr, entry);

    ws.addEventListener("open", () => {
      console.log(`[copy-trade] WS connected for ${wallet.label ?? addr}`);
      entry.reconnectAttempts = 0;
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : String(evt.data);
      const swap = parseWsMessage(raw, wallet);
      if (swap !== null) {
        void handleSwapEvent(wallet, swap);
      }
    });

    ws.addEventListener("error", (err) => {
      console.error(`[copy-trade] WS error for ${addr}:`, err);
    });

    ws.addEventListener("close", (evt) => {
      console.warn(
        `[copy-trade] WS closed for ${addr} code=${evt.code}, reconnecting in ${backoffMs}ms`,
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
  console.log(`[copy-trade] wallet removed: ${addr}`);
}

export function startCopyTradeAgent(): { stop(): void } {
  console.log("[copy-trade] agent started");

  const onAddWallet = (wallet: WatchedWallet): void => {
    const addr = wallet.address.toLowerCase();
    if (!watchedWallets.has(addr)) {
      watchedWallets.set(addr, wallet);
      connectWallet(wallet);
      console.log(`[copy-trade] now watching: ${wallet.label ?? addr}`);
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
