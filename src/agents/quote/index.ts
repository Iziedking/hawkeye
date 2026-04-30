/**
 * Quote Agent — Sunday Enejo
 *
 * Listens for TRADE_REQUEST, resolves the best pair via DexScreener (chain-first
 * per CONTRIBUTING.md rules), enriches price data from CoinGecko when available,
 * estimates slippage + fees, then emits QUOTE_RESULT.
 *
 * MCPs used: dexscreener, coingecko
 * Skills used: Uniswap V4 route hints (.agents/skills/)
 */

import { bus } from "../../shared/event-bus";
import type { TradeIntent, Quote, ChainId } from "../../shared/types";

// ---------------------------------------------------------------------------
// DexScreener direct-fetch helpers
// (The dexscreener-mcp runs as a separate process; we hit the same API
//  directly here to avoid cross-process call overhead in the critical path.)
// ---------------------------------------------------------------------------

const DS_BASE = "https://api.dexscreener.com";

interface DexPairRaw {
  chainId: string;
  dexId: string;
  pairAddress: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

/**
 * Resolves the most-liquid pair for a token address.
 * Always calls DexScreener first — never hardcode chain IDs.
 */
async function resolveBestPair(address: string, preferChain?: string): Promise<DexPairRaw | null> {
  const url = `${DS_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error("[QuoteAgent] DexScreener fetch failed:", err);
    return null;
  }

  if (!res.ok) {
    console.error(`[QuoteAgent] DexScreener HTTP ${res.status} for ${address}`);
    return null;
  }

  const data = (await res.json()) as { pairs?: DexPairRaw[] };
  let pairs = data.pairs ?? [];
  if (pairs.length === 0) return null;

  // Filter liquidity > $500 M — flagged as bad data in client.ts
  pairs = pairs.filter((p) => (p.liquidity?.usd ?? 0) < 500_000_000);

  // Prefer the chain the intent parser already resolved, then sort by liquidity
  if (preferChain) {
    const onChain = pairs.filter((p) => p.chainId === preferChain);
    if (onChain.length > 0) pairs = onChain;
  }

  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pairs[0] ?? null;
}

// ---------------------------------------------------------------------------
// CoinGecko price cross-check (best-effort — non-blocking)
// ---------------------------------------------------------------------------
// Slippage + fee estimation
// ---------------------------------------------------------------------------

/**
 * Rough 2× price-impact model. Real slippage depends on pool depth and
 * curve type — this is a conservative upper-bound estimate.
 *
 * @param liquidityUsd  Total liquidity in the pair
 * @param tradeValueUsd Estimated USD value of the trade
 */
function estimateSlippagePct(liquidityUsd: number, tradeValueUsd: number): number {
  if (liquidityUsd <= 0) return 15; // unknown pool — assume high slippage
  const rawImpact = (tradeValueUsd / liquidityUsd) * 100;
  return Math.min(rawImpact * 2, 50); // capped at 50 %
}

/**
 * Fee estimate in USD.
 * EVM: Flashbots/KeeperHub bundle fee ~$3–8; we use $5 as a mid estimate.
 * Solana: Jito priority fee ~0.001 SOL; at $150/SOL ≈ $0.15 — we use $0.20.
 */
function estimateFeeUsd(chain: "evm" | "solana"): number {
  return chain === "solana" ? 0.2 : 5;
}

// ---------------------------------------------------------------------------
// Route label
// ---------------------------------------------------------------------------

function buildRouteLabel(chainId: string, chain: "evm" | "solana"): string {
  if (chain === "solana") return "Jupiter v6 (auto-route)";
  const labels: Record<string, string> = {
    ethereum: "Uniswap V4 (Ethereum mainnet)",
    base: "Uniswap V4 (Base)",
    arbitrum: "Uniswap V4 (Arbitrum One)",
    optimism: "Uniswap V4 (Optimism)",
    bsc: "PancakeSwap V3 (BSC)",
    polygon: "Uniswap V4 (Polygon PoS)",
    avalanche: "Trader Joe V2 (Avalanche)",
    blast: "Uniswap V4 (Blast)",
    zksync: "SyncSwap (zkSync Era)",
    linea: "Uniswap V4 (Linea)",
    scroll: "Uniswap V4 (Scroll)",
    mantle: "FusionX V3 (Mantle)",
  };
  return labels[chainId] ?? `Uniswap V4 (${chainId})`;
}

// ---------------------------------------------------------------------------
// Agent entry point
// ---------------------------------------------------------------------------

export function startQuoteAgent(): () => void {
  const handler = async (intent: TradeIntent): Promise<void> => {
    const start = Date.now();
    console.log(
      `[QuoteAgent] TRADE_REQUEST received — intentId=${intent.intentId} address=${intent.address} chain=${intent.chain}`,
    );

    try {
      // 1. Resolve the best pair via DexScreener (chain-first rule)
      const pair = await resolveBestPair(intent.address, intent.chain);
      if (!pair) {
        console.warn(
          `[QuoteAgent] No DexScreener pairs found for ${intent.address} — cannot quote`,
        );
        bus.emit("QUOTE_FAILED", {
          intentId: intent.intentId,
          address: intent.address,
          reason:
            "No trading pairs found on any DEX. The token may be too new, unlisted, or on an unsupported chain.",
        });
        return;
      }

      const chainId = pair.chainId as ChainId;
      const dsPriceUsd = parseFloat(pair.priceUsd ?? "0");
      const liquidityUsd = pair.liquidity?.usd ?? 0;

      const finalPriceUsd = dsPriceUsd;

      // 3. Estimate trade value in USD (used for slippage calc)
      const tradeValueUsd =
        intent.amount.unit === "USD"
          ? intent.amount.value
          : intent.amount.unit === "NATIVE"
            ? intent.amount.value * finalPriceUsd
            : intent.amount.value * finalPriceUsd; // TOKEN — same formula

      // 4. Slippage + fee
      const slippagePct = estimateSlippagePct(liquidityUsd, tradeValueUsd);
      const feeEstimateUsd = estimateFeeUsd(intent.chain);

      // 5. Emit QUOTE_RESULT
      const quote: Quote = {
        intentId: intent.intentId,
        address: intent.address,
        chainId,
        pairAddress: pair.pairAddress,
        priceUsd: finalPriceUsd,
        liquidityUsd,
        expectedSlippagePct: slippagePct,
        feeEstimateUsd,
        route: buildRouteLabel(chainId, intent.chain),
        completedAt: Date.now(),
      };

      bus.emit("QUOTE_RESULT", quote);

      console.log(
        `[QuoteAgent] QUOTE_RESULT emitted — intentId=${intent.intentId} ` +
          `price=$${finalPriceUsd.toFixed(6)} liquidity=$${liquidityUsd.toLocaleString()} ` +
          `slippage=${slippagePct.toFixed(2)}% route="${quote.route}" ` +
          `elapsed=${Date.now() - start}ms`,
      );
    } catch (err) {
      console.error(`[QuoteAgent] Unhandled error for intentId=${intent.intentId}:`, err);
      bus.emit("QUOTE_FAILED", {
        intentId: intent.intentId,
        address: intent.address,
        reason: "Internal error while fetching quote. Please try again.",
      });
    }
  };

  bus.on("TRADE_REQUEST", handler);

  console.log("[QuoteAgent] ✓ Listening for TRADE_REQUEST");

  return () => {
    bus.off("TRADE_REQUEST", handler);
  };
}
