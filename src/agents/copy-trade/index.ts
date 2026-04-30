import bus from "../../shared/event-bus";
import type {
  TradeIntent,
  ChainId,
  ChainClass,
  MessageChannel,
  TradingMode,
} from "../../shared/types";

interface CopyTradeFilters {
  minTradeSizeUsd: number;
  tokenWhitelist: Set<string>;
  tokenBlacklist: Set<string>;
  delayMs: number;
}

const DEFAULT_FILTERS: CopyTradeFilters = {
  minTradeSizeUsd: 100,
  tokenWhitelist: new Set(),
  tokenBlacklist: new Set(),
  delayMs: 0,
};

interface WatchedWallet {
  address: string;
  label?: string;
  chain: ChainClass;
  chainId: ChainId;
  rpcUrl: string;
}

interface PendingCopy {
  intent: TradeIntent;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_URLS: Partial<Record<ChainId, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base:     "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  bsc:      "https://bsc-rpc.publicnode.com",
  polygon:  "https://polygon-rpc.com",
  sepolia:  "https://ethereum-sepolia-rpc.publicnode.com",
};

const DEFAULT_RPC = RPC_URLS["ethereum"] as string;
const POLL_INTERVAL_MS = 12_000;
const SEEN_TX_LIMIT = 10_000;
const SEEN_TX_PRUNE = 2_000;

// Uniswap V2 + V3 Swap event signatures.
const SWAP_TOPICS = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
]);

const watchedWallets = new Map<string, WatchedWallet>();
const pendingCopies  = new Map<string, PendingCopy>();
const seenTxHashes   = new Set<string>();

let filters: CopyTradeFilters = { ...DEFAULT_FILTERS };
let pollHandle: ReturnType<typeof setInterval> | null = null;

function passesFilters(intent: TradeIntent): { ok: boolean; reason?: string } {
  if (intent.amount.unit === "USD" && intent.amount.value < filters.minTradeSizeUsd)
    return { ok: false, reason: `$${intent.amount.value} below minimum $${filters.minTradeSizeUsd}` };

  if (filters.tokenBlacklist.has(intent.address.toLowerCase()))
    return { ok: false, reason: `${intent.address} is blacklisted` };

  if (filters.tokenWhitelist.size > 0 && !filters.tokenWhitelist.has(intent.address.toLowerCase()))
    return { ok: false, reason: `${intent.address} not in whitelist` };

  return { ok: true };
}

function trackTxHash(txHash: string): boolean {
  if (seenTxHashes.has(txHash)) return false;
  seenTxHashes.add(txHash);

  if (seenTxHashes.size > SEEN_TX_LIMIT) {
    const iter = seenTxHashes.values();
    for (let i = 0; i < SEEN_TX_PRUNE; i++) {
      const next = iter.next();
      if (next.done) break;
      seenTxHashes.delete(next.value);
    }
  }

  return true;
}

interface RpcResponse<T> { result: T | null }

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json() as RpcResponse<T>;
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function getLatestBlockNumber(rpcUrl: string): Promise<number | null> {
  const hex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  return hex !== null ? parseInt(hex, 16) : null;
}

async function getSwapTxsInLatestBlock(wallet: WatchedWallet): Promise<string[]> {
  interface Log   { topics: string[] }
  interface Tx    { from: string; hash: string }
  interface Block { transactions: Tx[] }
  interface Receipt { logs: Log[] }

  const blockNum = await getLatestBlockNumber(wallet.rpcUrl);
  if (blockNum === null) return [];

  const block = await rpcCall<Block>(wallet.rpcUrl, "eth_getBlockByNumber", [
    `0x${blockNum.toString(16)}`,
    true,
  ]);
  if (!block) return [];

  const walletTxs = block.transactions.filter(
    (tx) => tx.from.toLowerCase() === wallet.address.toLowerCase(),
  );
  if (walletTxs.length === 0) return [];

  const receipts = await Promise.all(
    walletTxs.map((tx) =>
      rpcCall<Receipt>(wallet.rpcUrl, "eth_getTransactionReceipt", [tx.hash]),
    ),
  );

  return walletTxs
    .filter((_, i) =>
      receipts[i]?.logs.some((log) =>
        SWAP_TOPICS.has((log.topics[0] ?? "").toLowerCase()),
      ) ?? false,
    )
    .map((tx) => tx.hash);
}

function scheduleTradeRequest(intent: TradeIntent): void {
  const check = passesFilters(intent);
  if (!check.ok) {
    console.log(`[CopyTrade] blocked — ${check.reason}`);
    return;
  }

  if (filters.delayMs > 0) {
    const timer = setTimeout(() => {
      bus.emit("TRADE_REQUEST", intent);
      pendingCopies.delete(intent.intentId);
      console.log(`[CopyTrade] emitted after ${filters.delayMs}ms — ${intent.intentId}`);
    }, filters.delayMs);
    pendingCopies.set(intent.intentId, { intent, timer });
    console.log(`[CopyTrade] queued ${intent.intentId} (${filters.delayMs}ms delay)`);
  } else {
    bus.emit("TRADE_REQUEST", intent);
    console.log(`[CopyTrade] TRADE_REQUEST — ${intent.intentId}`);
  }
}

async function handleCopyTradeRequest(incoming: TradeIntent): Promise<void> {
  const sourceAddr = incoming.userId.startsWith("copy-trade:")
    ? incoming.userId.slice("copy-trade:".length)
    : null;

  if (sourceAddr !== null) {
    const key = sourceAddr.toLowerCase();
    if (!watchedWallets.has(key)) {
      const rpcUrl = RPC_URLS[incoming.chainHint ?? "ethereum"] ?? DEFAULT_RPC;
      watchedWallets.set(key, {
        address: sourceAddr,
        chain:   incoming.chain,
        chainId: incoming.chainHint ?? "ethereum",
        rpcUrl,
      });
      console.log(`[CopyTrade] auto-watching ${sourceAddr}`);
    }
  }

  scheduleTradeRequest({
    ...incoming,
    intentId:  `copy-${incoming.intentId}-${Date.now()}`,
    rawText:   `[Copy] ${incoming.rawText}`,
    createdAt: Date.now(),
  });
}

async function pollWallets(): Promise<void> {
  if (watchedWallets.size === 0) return;

  await Promise.all(
    Array.from(watchedWallets.values()).map(async (wallet) => {
      const swapTxs = await getSwapTxsInLatestBlock(wallet);

      for (const txHash of swapTxs) {
        if (!trackTxHash(txHash)) continue;

        console.log(`[CopyTrade] swap — ${wallet.label ?? wallet.address} tx=${txHash}`);

        // Use INSTANT to match the speed of the original trade.
        const urgency: TradingMode = "INSTANT";

        scheduleTradeRequest({
          intentId:  `rpc-${txHash}-${Date.now()}`,
          userId:    `copy-trade:${wallet.address}`,
          channel:   "webchat" as MessageChannel,
          address:   wallet.address,
          chain:     wallet.chain,
          chainHint: wallet.chainId,
          amount:    { value: 0, unit: "USD" },
          exits:     [],
          urgency,
          rawText:   `RPC copy — ${wallet.label ?? wallet.address} tx=${txHash}`,
          createdAt: Date.now(),
        });
      }
    }),
  );
}

export function startCopyTradeAgent(): { stop(): void } {
  console.log("[CopyTrade] started");

  bus.on("COPY_TRADE_REQUEST", (intent: TradeIntent) => {
    void handleCopyTradeRequest(intent);
  });

  pollHandle = setInterval(() => { void pollWallets(); }, POLL_INTERVAL_MS);

  return {
    stop() {
      if (pollHandle !== null) { clearInterval(pollHandle); pollHandle = null; }
      for (const p of pendingCopies.values()) clearTimeout(p.timer);
      pendingCopies.clear();
      console.log("[CopyTrade] stopped");
    },
  };
}

export function setCopyTradeFilters(patch: Partial<CopyTradeFilters>): void {
  filters = { ...filters, ...patch };
}

export function addWatchedWallet(
  wallet: Omit<WatchedWallet, "rpcUrl"> & { rpcUrl?: string },
): void {
  const rpcUrl = wallet.rpcUrl ?? RPC_URLS[wallet.chainId] ?? DEFAULT_RPC;
  watchedWallets.set(wallet.address.toLowerCase(), { ...wallet, rpcUrl });
  console.log(`[CopyTrade] watching ${wallet.label ?? wallet.address}`);
}

export function removeWatchedWallet(address: string): void {
  watchedWallets.delete(address.toLowerCase());
  console.log(`[CopyTrade] removed ${address}`);
}

export function getWatchedWalletCount(): number  { return watchedWallets.size; }
export function getWatchedWalletAddresses(): string[] { return [...watchedWallets.keys()]; }
export function getPendingCopyCount(): number    { return pendingCopies.size; }