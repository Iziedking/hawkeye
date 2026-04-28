// Research Agent — discovers alpha tokens (background loop) and answers research questions.
//
// Job 1 — Background discovery loop (fires every 30 seconds):
//   Polls DexScreener for new/trending tokens → security scan → holder/age intelligence
//   → trend signal → narrative multiplier → emits ALPHA_FOUND for anything that passes.
//
// Job 2 — Research request handler (event-driven):
//   Gateway emits RESEARCH_REQUEST when a user asks about a token.
//   Agent pulls full data from all sources, synthesises a verdict via OpenRouter (local)
//   or 0G Compute (production), emits RESEARCH_RESULT.
//
// Source stack:
//   Security   : GoPlus (EVM), Honeypot.is (EVM), RugCheck (Solana)
//   Market     : DexScreener, CoinGecko, Birdeye (Solana)
//   Holders    : Etherscan (EVM), Solscan (Solana), Arkham (entity labels, both)
//   Sentiment  : Alternative.me Fear & Greed Index (market-wide, free)
//   Trend      : CryptoPanic (crypto news + votes), Brave Search (global web),
//                Reddit (community volume), Tavily (deep fallback)
//   Synthesis  : OpenRouter locally → 0G Compute in production

import { bus } from "../shared/event-bus";
import type { AlphaFoundPayload, ResearchRequest, ChainId } from "../shared/types";
import {
  getLatestTokenProfiles,
  getLatestBoosts,
  getPairsByToken,
  isValidChain,
} from "../tools/dexscreener-mcp/client";
import type { DexPair, DexScreenerChain } from "../tools/dexscreener-mcp/client";

// ─── Constants ─────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 30_000; // discovery loop cadence
const MIN_LIQUIDITY_USD = 10_000; // below this, a single trade moves price 10%+ — not viable
const MIN_VOLUME_24H    = 50_000; // below this, likely wash trading or a dead market
const ALPHA_THRESHOLD   = 65;     // minimum opportunityScore to emit ALPHA_FOUND

// ─── Seen token registry ───────────────────────────────────────────────────────
// Keeps track of every token the polling loop has already evaluated so we never
// re-process the same address across cycles.
// Key: "${chainId}:${address.toLowerCase()}"
const seenTokens = new Set<string>();

// ─── Chain class helper ────────────────────────────────────────────────────────
function detectChainClass(address: string): "evm" | "solana" {
  return address.startsWith("0x") ? "evm" : "solana";
}

// ─── Polling cycle ─────────────────────────────────────────────────────────────
// Fetches the latest token profiles and boosts from DexScreener, deduplicates
// against the seen-token registry, and fires processCandidate() for each new one.
// Each candidate is processed independently — one failure doesn't abort the cycle.
async function runPollingCycle(): Promise<void> {
  try {
    const [profiles, boosts] = await Promise.all([
      getLatestTokenProfiles(),
      getLatestBoosts(),
    ]);

    // Merge both sources. Boosts are paid promotions but often have real momentum.
    const candidates = new Map<string, { address: string; chainId: DexScreenerChain }>();
    for (const item of [...profiles, ...boosts]) {
      if (!isValidChain(item.chainId)) continue;
      const key = `${item.chainId}:${item.tokenAddress.toLowerCase()}`;
      if (!seenTokens.has(key)) {
        candidates.set(key, {
          address: item.tokenAddress,
          chainId: item.chainId as DexScreenerChain,
        });
      }
    }

    if (candidates.size > 0) {
      console.log(`[research] poll: ${candidates.size} new candidate(s)`);
    }

    for (const [key, candidate] of candidates) {
      // Mark seen immediately — even if processing fails, don't retry next cycle.
      seenTokens.add(key);
      void processCandidate(candidate.address, candidate.chainId);
    }
  } catch (err) {
    console.error("[research] polling cycle error:", err);
  }
}

// ─── Candidate pipeline ────────────────────────────────────────────────────────
// Runs a single token through the full evaluation pipeline. Each commit adds one
// more stage. At the end, if the opportunityScore clears the threshold, ALPHA_FOUND
// is emitted.
async function processCandidate(
  address: string,
  chainId: DexScreenerChain,
): Promise<void> {
  try {
    // ── Stage 1: DexScreener liquidity + volume filter ─────────────────────────
    // Pick the highest-liquidity pair for this token as the canonical data point.
    // If DexScreener has no pair data, skip — we have nothing to evaluate.
    const pairs = await getPairsByToken(chainId, address).catch(() => [] as DexPair[]);
    const best  = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return;

    const liquidityUsd = best.liquidity?.usd   ?? 0;
    const volume24h    = best.volume?.h24       ?? 0;
    const ticker       = best.baseToken.symbol;
    const tokenName    = best.baseToken.name;
    const priceUsd     = parseFloat(best.priceUsd ?? "0") || 0;

    if (liquidityUsd < MIN_LIQUIDITY_USD || volume24h < MIN_VOLUME_24H) return;

    console.log(
      `[research] candidate: ${ticker} (${chainId})` +
      ` liq=$${liquidityUsd.toFixed(0)} vol24h=$${volume24h.toFixed(0)}`,
    );

    // ── Stage 2: security scan — added in Commit 2 ─────────────────────────────
    // GoPlus + Honeypot.is (EVM) or RugCheck (Solana).
    // Hard drops: HONEYPOT flag, token age < 1 hour, holder concentration > 80%.

    // ── Stage 3: holder/age intelligence — added in Commit 3 ───────────────────
    // Etherscan/Solscan for contract age + top holders.
    // Arkham for entity labels on creator + top holders.
    // Emits ALPHA_FOUND once opportunity score is computed.

    // ── Stage 4: trend signal + narrative multiplier — added in Commit 4 ────────
    // CryptoPanic (crypto sentiment), Brave Search (global web), Reddit (community),
    // Alternative.me (market fear/greed), Tavily (deep fallback for partial signal).
    // multiplier: 1.0x – 1.8x applied to safety score → opportunityScore.

    // Suppress unused-variable warnings until later commits populate these fields.
    void ticker; void tokenName; void priceUsd;

  } catch (err) {
    console.error(`[research] error processing ${address} (${chainId}):`, err);
  }
}

// ─── RESEARCH_REQUEST handler ──────────────────────────────────────────────────
// Full implementation in Commit 5. Receives a user-initiated research question,
// runs the complete source stack (security + market + holder + trend + LLM),
// and emits RESEARCH_RESULT.
async function handleResearchRequest(req: ResearchRequest): Promise<void> {
  console.log(`[research] RESEARCH_REQUEST for ${req.address ?? req.tokenName ?? "unknown"} — full handler in Commit 5`);
  void req;
}

// ─── Agent entry point ─────────────────────────────────────────────────────────
/**
 * Starts the Research Agent. Call once from src/index.ts at boot time.
 *
 * Job 1: background polling loop — emits ALPHA_FOUND for tokens that pass all gates.
 * Job 2: RESEARCH_REQUEST listener — emits RESEARCH_RESULT with LLM-synthesised verdict.
 *
 * Keys required (add to .env.local — never committed):
 *   ETHERSCAN_API_KEY, BIRDEYE_API_KEY, ARKHAM_API_KEY, BRAVE_API_KEY,
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, CRYPTOPANIC_AUTH_TOKEN,
 *   TAVILY_API_KEY, OPENROUTER_API_KEY (local) or HAWKEYE_EVM_PRIVATE_KEY (production)
 */
export function startResearchAgent(): void {
  // Fire the first poll cycle immediately, then repeat on the interval.
  void runPollingCycle();
  setInterval(() => { void runPollingCycle(); }, POLL_INTERVAL_MS);

  // Job 2 listener — registered now, implemented in Commit 5.
  bus.on("RESEARCH_REQUEST", (req: ResearchRequest) => {
    void handleResearchRequest(req);
  });

  console.log("[research] Research Agent started — polling every 30s, listening for RESEARCH_REQUEST");
}
