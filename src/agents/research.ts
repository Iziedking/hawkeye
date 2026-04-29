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
//   Trend      : Brave Search ×2 (global + crypto-specific), Stocktwits (trading community),
//                Farcaster/Neynar (Web3-native community), Tavily (deep fallback)
//   Synthesis  : OpenRouter locally → 0G Compute in production

import { bus } from "../shared/event-bus";
import type { AlphaFoundPayload, ResearchRequest, ChainId, SafetyFlag } from "../shared/types";
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

// ─── Security scanning ────────────────────────────────────────────────────────
// Intentionally duplicated from safety.ts — agents don't import each other.
// GoPlus + Honeypot.is for EVM, RugCheck for Solana. Same scoring as safety.ts
// so ALPHA_FOUND safetyScore and SAFETY_RESULT score are always comparable.

const CHAIN_NUMERIC_ID: Record<string, number> = {
  ethereum: 1,   bsc: 56,       polygon: 137,  arbitrum: 42161,
  base: 8453,    optimism: 10,  avalanche: 43114, fantom: 250,
  cronos: 25,    zksync: 324,   linea: 59144,  blast: 81457,
  scroll: 534352, mantle: 5000, celo: 42220,   ronin: 2020,
  unichain: 130, gnosis: 100,   berachain: 80094, hyperevm: 999,
  monad: 41454,  mode: 34443,   worldchain: 480,
};

const FLAG_DEDUCTIONS: Partial<Record<SafetyFlag, number>> = {
  HONEYPOT: 100, KNOWN_RUGGER: 50,  PHISHING_ORIGIN: 30,
  MINT_AUTHORITY: 25, FREEZE_AUTHORITY: 25, HIGH_TAX: 25,
  BLACKLIST: 20, LOW_LIQUIDITY: 20, UNVERIFIED_CONTRACT: 15, PROXY_CONTRACT: 10,
};

function computeScore(flags: SafetyFlag[]): number {
  const deduction = flags.reduce((t, f) => t + (FLAG_DEDUCTIONS[f] ?? 0), 0);
  return Math.max(0, 100 - deduction);
}

async function runSecurityScan(
  address: string,
  chainClass: "evm" | "solana",
  chainId: string,
): Promise<{ flags: SafetyFlag[]; score: number; ok: boolean }> {
  const flags: SafetyFlag[] = [];
  let ok = true;

  if (chainClass === "evm") {
    const numericId = CHAIN_NUMERIC_ID[chainId] ?? 1;

    // GoPlus + Honeypot.is in parallel — independent simulations catch different cases.
    const [goplusResp, honeypotResp] = await Promise.allSettled([
      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/${numericId}` +
        `?contract_addresses=${address.toLowerCase()}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
      ),
      fetch(
        `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${numericId}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) },
      ),
    ]);

    if (goplusResp.status === "fulfilled" && goplusResp.value.ok) {
      const body = await goplusResp.value.json() as { result?: Record<string, Record<string, string>> };
      const data = body.result?.[address.toLowerCase()];
      if (data) {
        if (data["is_honeypot"] === "1")                flags.push("HONEYPOT");
        if (data["is_mintable"] === "1")                flags.push("MINT_AUTHORITY");
        if (data["is_proxy"] === "1")                   flags.push("PROXY_CONTRACT");
        if (data["is_blacklisted"] === "1")             flags.push("BLACKLIST");
        if (data["is_open_source"] !== "1")             flags.push("UNVERIFIED_CONTRACT");
        if (data["honeypot_with_same_creator"] === "1") flags.push("KNOWN_RUGGER");
        const buyTax  = parseFloat(data["buy_tax"]  ?? "0");
        const sellTax = parseFloat(data["sell_tax"] ?? "0");
        if (buyTax > 0.1 || sellTax > 0.1) flags.push("HIGH_TAX");
      } else {
        flags.push("UNVERIFIED_CONTRACT"); ok = false;
      }
    } else {
      flags.push("UNVERIFIED_CONTRACT"); ok = false;
    }

    if (honeypotResp.status === "fulfilled" && honeypotResp.value.ok) {
      const body = await honeypotResp.value.json() as { isHoneypot?: boolean };
      if (body.isHoneypot && !flags.includes("HONEYPOT")) flags.push("HONEYPOT");
    }

  } else {
    // Solana — RugCheck replaces both EVM scanners.
    try {
      const resp = await fetch(
        `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
      );
      if (resp.ok) {
        const report = await resp.json() as {
          freezeAuthority?: string | null;
          mintAuthority?:   string | null;
          risks?: Array<{ name: string; level?: string }>;
        };
        if (report.freezeAuthority) flags.push("FREEZE_AUTHORITY");
        if (report.mintAuthority)   flags.push("MINT_AUTHORITY");
        for (const risk of report.risks ?? []) {
          const n = risk.name.toLowerCase();
          if (n.includes("honeypot") || n.includes("rugged")) flags.push("HONEYPOT");
          if (n.includes("blacklist"))                         flags.push("BLACKLIST");
          if (risk.level === "danger" && n.includes("tax"))   flags.push("HIGH_TAX");
        }
      } else {
        flags.push("UNVERIFIED_CONTRACT"); ok = false;
      }
    } catch {
      flags.push("UNVERIFIED_CONTRACT"); ok = false;
    }
  }

  const unique = [...new Set(flags)] as SafetyFlag[];
  return { flags: unique, score: computeScore(unique), ok };
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

    // ── Stage 2: security scan ─────────────────────────────────────────────────
    const chainClass = detectChainClass(address);
    const security   = await runSecurityScan(address, chainClass, chainId);

    // Hard drop 1: confirmed honeypot — never surface these to users.
    if (security.flags.includes("HONEYPOT")) {
      console.log(`[research] drop ${ticker}: HONEYPOT`);
      return;
    }

    // Hard drop 2: known rugger wallet deployed this token.
    if (security.flags.includes("KNOWN_RUGGER")) {
      console.log(`[research] drop ${ticker}: KNOWN_RUGGER`);
      return;
    }

    const safetyScore = security.score;

    // ── Stage 3: holder/age intelligence — added in Commit 3 ───────────────────
    // Etherscan/Solscan for contract age + top holders.
    // Arkham for entity labels on creator + top holders.
    // Hard drops: token < 1 hour old, top-3 holders > 80% concentration.
    // Emits ALPHA_FOUND once opportunity score is computed.

    // ── Stage 4: trend signal + narrative multiplier — added in Commit 4 ────────
    // Brave ×2 (global + crypto), Stocktwits, Farcaster/Neynar,
    // Alternative.me (fear/greed), Tavily (deep fallback).
    // multiplier: 1.0x–1.8x applied to safetyScore → opportunityScore.

    void tokenName; void priceUsd; void safetyScore; // used from Commit 3 onward

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
