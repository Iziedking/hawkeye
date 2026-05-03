/**
 * Wallet Watcher Agent
 *
 * Polls every active user's wallet on a fixed interval and emits
 * `WALLET_FUNDED` whenever the native or a tracked-ERC-20 balance grows.
 * The Telegram gateway listens and pings the user.
 *
 * Design notes:
 * - First observation per (user, chain, asset) seeds the baseline; we never
 *   emit on the seed read so a restart can't trigger a flood of "received"
 *   alerts for funds that were already there.
 * - The watcher reads the user list from the JsonStore on every tick so new
 *   users start being watched without a restart.
 * - Native balance for every supported chain is checked every cycle (cheap:
 *   one eth_getBalance per chain). ERC-20 balance is only checked for tokens
 *   the user has touched (open positions + seenTokens) so the per-cycle cost
 *   stays bounded by activity, not by token universe size.
 * - All RPC failures are silent — the next tick will retry. We don't want
 *   transient RPC blips to either alert the user or crash the agent.
 */

import { bus } from "../../shared/event-bus";
import { JsonStore } from "../../shared/store";
import {
  fetchNativeBalance,
  fetchTokenBalance,
  fetchTokenDecimals,
  EVM_CHAIN_CONFIG,
} from "../../shared/evm-chains";
import { getPositionsByUser } from "../execution/position-store";
import { getSeenTokens } from "../../shared/seen-tokens";
import type { ChainId, WalletFundedAsset } from "../../shared/types";

// Cache decimals per (chain, token) so we don't hit RPC every tick. Decimals
// are immutable for an ERC-20 — once we know them we can keep them forever.
const decimalsCache = new Map<string, number>();

async function resolveDecimals(chainId: string, tokenAddress: string): Promise<number> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = await fetchTokenDecimals(chainId, tokenAddress);
  decimalsCache.set(key, decimals);
  return decimals;
}

const POLL_INTERVAL_MS = 60_000;

// Chains we sweep every tick for native balances. Keep this short — every
// entry adds one RPC per user per cycle. ERC-20 reads piggy-back on whatever
// chains the user has touched (positions + seen tokens).
const NATIVE_WATCH_CHAINS: ChainId[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bsc",
  "sepolia",
];

// Suppress dust-level alerts. Native: 0.00001 token (10 gwei worth on ETH —
// below this is almost certainly an internal accounting artifact, not a real
// inbound transfer the user cares about).
const NATIVE_MIN_DELTA_RAW = 10_000_000_000n; // 1e10 wei

// ERC-20: 0.000001 token. Decimals vary so we apply the threshold in human
// units after dividing.
const ERC20_MIN_DELTA_DISPLAY = 0.000001;

type AssetKey = string; // `${userId}|${chainId}|native` | `${userId}|${chainId}|erc20:${addr}`

const lastBalances = new Map<AssetKey, bigint>();

function nativeKey(userId: string, chainId: ChainId): AssetKey {
  return `${userId}|${chainId}|native`;
}

function erc20Key(userId: string, chainId: ChainId, address: string): AssetKey {
  return `${userId}|${chainId}|erc20:${address.toLowerCase()}`;
}

function formatRaw(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

async function checkNative(userId: string, walletAddress: string, chainId: ChainId): Promise<void> {
  const { balance, error } = await fetchNativeBalance(chainId, walletAddress);
  if (error) return;

  const key = nativeKey(userId, chainId);
  const prev = lastBalances.get(key);

  if (prev === undefined) {
    lastBalances.set(key, balance);
    return;
  }

  if (balance <= prev) {
    lastBalances.set(key, balance);
    return;
  }

  const delta = balance - prev;
  if (delta < NATIVE_MIN_DELTA_RAW) {
    lastBalances.set(key, balance);
    return;
  }

  const cfg = EVM_CHAIN_CONFIG[chainId];
  const symbol = cfg?.nativeCurrency ?? "ETH";

  const asset: WalletFundedAsset = { kind: "native", symbol };

  bus.emit("WALLET_FUNDED", {
    userId,
    walletAddress,
    chainId,
    asset,
    amountRaw: delta.toString(),
    amountDisplay: formatRaw(delta, 18),
    previousBalanceRaw: prev.toString(),
    newBalanceRaw: balance.toString(),
    detectedAt: Date.now(),
  });

  lastBalances.set(key, balance);
}

async function checkErc20(
  userId: string,
  walletAddress: string,
  chainId: ChainId,
  tokenAddress: string,
  symbol: string,
): Promise<void> {
  const { balance, error } = await fetchTokenBalance(chainId, tokenAddress, walletAddress);
  if (error) return;

  // Resolve decimals lazily so the cache only fills for tokens the user
  // actually holds — and we don't pay an extra RPC for every empty-balance
  // probe across every position.
  const decimals = await resolveDecimals(chainId, tokenAddress);

  const key = erc20Key(userId, chainId, tokenAddress);
  const prev = lastBalances.get(key);

  if (prev === undefined) {
    lastBalances.set(key, balance);
    return;
  }

  if (balance <= prev) {
    lastBalances.set(key, balance);
    return;
  }

  const delta = balance - prev;
  const deltaDisplay = parseFloat(formatRaw(delta, decimals));
  if (deltaDisplay < ERC20_MIN_DELTA_DISPLAY) {
    lastBalances.set(key, balance);
    return;
  }

  const asset: WalletFundedAsset = {
    kind: "erc20",
    address: tokenAddress,
    symbol,
    decimals,
  };

  bus.emit("WALLET_FUNDED", {
    userId,
    walletAddress,
    chainId,
    asset,
    amountRaw: delta.toString(),
    amountDisplay: formatRaw(delta, decimals),
    previousBalanceRaw: prev.toString(),
    newBalanceRaw: balance.toString(),
    detectedAt: Date.now(),
  });

  lastBalances.set(key, balance);
}

type WatchTarget = {
  userId: string; // canonical email
  walletAddress: string;
};

function enumerateTargets(store: JsonStore): WatchTarget[] {
  const out: WatchTarget[] = [];
  const all = store.allUsers();
  for (const [email, user] of Object.entries(all)) {
    if (!user.agentWallet?.address) continue;
    out.push({ userId: email, walletAddress: user.agentWallet.address });
  }
  return out;
}

function enumerateErc20s(
  userId: string,
): Array<{ chainId: string; address: string; symbol: string }> {
  const out: Array<{ chainId: string; address: string; symbol: string }> = [];
  const seen = new Set<string>();
  for (const p of getPositionsByUser(userId)) {
    const k = `${p.chainId}:${p.address.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      chainId: p.chainId,
      address: p.address,
      symbol: p.symbol ?? p.address.slice(0, 6),
    });
  }
  for (const t of getSeenTokens(userId)) {
    const k = `${t.chainId}:${t.address.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol ?? t.address.slice(0, 6),
    });
  }
  return out;
}

async function tick(store: JsonStore): Promise<void> {
  const targets = enumerateTargets(store);
  if (targets.length === 0) return;

  const work: Array<Promise<unknown>> = [];

  for (const target of targets) {
    for (const chain of NATIVE_WATCH_CHAINS) {
      work.push(checkNative(target.userId, target.walletAddress, chain));
    }
    const tokens = enumerateErc20s(target.userId);
    for (const t of tokens) {
      // Only look at chains we have RPCs configured for.
      if (!(t.chainId in EVM_CHAIN_CONFIG)) continue;
      work.push(
        checkErc20(target.userId, target.walletAddress, t.chainId as ChainId, t.address, t.symbol),
      );
    }
  }

  await Promise.allSettled(work);
}

export function startWalletWatcherAgent(): { stop(): void } {
  console.log(`[wallet-watcher] agent started — polling every ${POLL_INTERVAL_MS / 1000}s`);

  // The store is a thin file reader; constructing it here keeps the watcher
  // standalone and avoids leaking a coupling to the wallet manager surface.
  const store = new JsonStore();

  let running = false;
  const timer = setInterval(() => {
    if (running) return; // skip if previous tick is still in flight
    running = true;
    tick(store)
      .catch((err) => console.warn(`[wallet-watcher] tick failed: ${(err as Error).message}`))
      .finally(() => {
        running = false;
      });
  }, POLL_INTERVAL_MS);

  // Kick the first tick immediately so baselines seed quickly.
  void tick(store).catch(() => {});

  return {
    stop(): void {
      clearInterval(timer);
      lastBalances.clear();
      decimalsCache.clear();
      console.log("[wallet-watcher] agent stopped");
    },
  };
}
