// Research Agent — discovers alpha tokens (background loop) and answers research questions.
//
// Job 1 — Background discovery loop (fires every 30 seconds):
//   Polls DexScreener for new/trending tokens → security scan → holder/age intelligence
//   → trend signal → narrative multiplier → emits ALPHA_FOUND for anything that passes.
//
// Job 2 — Research request handler (event-driven):
//   Gateway emits RESEARCH_REQUEST when a user asks about a token.
//   Agent pulls full data from all sources, synthesises a verdict via 0G Compute,
//   emits RESEARCH_RESULT.
//
// Source stack:
//   Security   : GoPlus (EVM), Honeypot.is (EVM), RugCheck (Solana)
//   Market     : DexScreener, CoinGecko, Birdeye (Solana)
//   Holders    : Etherscan (EVM), Solscan (Solana), Arkham (entity labels, both)
//   Sentiment  : Alternative.me Fear & Greed Index (market-wide, free)
//   Trend      : GDELT (250k+ global news sources, no key), RSS feeds (CoinDesk/CoinTelegraph/
//                Decrypt/Reuters/BBC — direct from source, no key), Stocktwits (trading community),
//                Farcaster/Neynar (Web3-native community), Alternative.me (market fear/greed)
//                Brave Search reserved for RESEARCH_REQUEST only (user-initiated, 2k/mo free tier)
//   Synthesis  : 0G Compute (OgComputeClient via HAWKEYE_EVM_PRIVATE_KEY)

import { bus } from "../shared/event-bus";
import type { AlphaFoundPayload, ResearchRequest, ResearchResult, ChainId, SafetyFlag } from "../shared/types";
import { OgComputeClient } from "../integrations/0g/compute";
import {
  getLatestTokenProfiles,
  getLatestBoosts,
  getPairsByToken,
  searchPairs,
  isValidChain,
} from "../tools/dexscreener-mcp/client";
import type { DexPair, DexScreenerChain } from "../tools/dexscreener-mcp/client";

// ─── Constants ─────────────────────────────────────────────────────────────────
// Tickers that are industry-standard acronyms (EVM = Ethereum Virtual Machine,
// NFT = non-fungible token, etc.). These generate structural false positives in
// every RSS/Reddit/news search by design — skip trend signal for them entirely.
// They can still pass via the fundamentals override in processCandidate.
const INDUSTRY_TERM_TICKERS = new Set([
  "EVM", "NFT", "DAO", "TVL", "DEX", "CEX", "APY", "APR",
  "L1", "L2", "TPS", "MEV", "RPC", "ABI", "ERC", "BEP", "SPL",
  "DeFi", "DEFI", "AMM", "LP", "VC",
]);

const POLL_INTERVAL_MS  = 30_000; // discovery loop cadence
const MIN_LIQUIDITY_USD = 50_000; // below this, a single trade moves price significantly — not viable
const MIN_VOLUME_24H    = 120_000; // below this, likely wash trading or a dead market
const MIN_VOL_LIQ_RATIO = 2;      // vol24h/liquidity — ensures real activity relative to pool size
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

// ─── Holder and age intelligence ──────────────────────────────────────────────
// EVM  → Etherscan: first tx timestamp for age, tokenholderlist + tokensupply for concentration.
// Solana → Solscan: tokenCreatedAt for age, holders endpoint for concentration.
// Arkham entity labels skipped until API key is approved — slot is reserved here.

type AgeAndHolders = {
  ageHours:      number | null; // null = could not determine (don't drop, just skip age check)
  top3Pct:       number | null; // null = could not determine (don't drop, just skip concentration check)
  holderCount:   number | null;
};

async function checkAgeAndHolders(
  address: string,
  chainClass: "evm" | "solana",
  chainId: string,
): Promise<AgeAndHolders> {
  if (chainClass === "evm") {
    return checkEtherscan(address, chainId);
  }
  return checkSolscan(address);
}

async function checkEtherscan(address: string, _chainId: string): Promise<AgeAndHolders> {
  const key = process.env["ETHERSCAN_API_KEY"] ?? "";
  if (!key) return { ageHours: null, top3Pct: null, holderCount: null };

  const base = "https://api.etherscan.io/api";

  try {
    // Age: pull the first transaction ever sent to/from this contract.
    // The earliest tx timestamp is the contract deployment time.
    const [ageResp, holdersResp, supplyResp] = await Promise.all([
      fetch(`${base}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${key}`, { signal: AbortSignal.timeout(8_000) }),
      fetch(`${base}?module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${key}`, { signal: AbortSignal.timeout(8_000) }),
      fetch(`${base}?module=stats&action=tokensupply&contractaddress=${address}&apikey=${key}`, { signal: AbortSignal.timeout(8_000) }),
    ]);

    // Age calculation
    let ageHours: number | null = null;
    if (ageResp.ok) {
      const body = await ageResp.json() as { result?: Array<{ timeStamp?: string }> };
      const ts = parseInt(body.result?.[0]?.timeStamp ?? "0", 10);
      if (ts > 0) ageHours = (Date.now() / 1000 - ts) / 3600;
    }

    // Holder concentration — top 3 holders as % of total supply
    let top3Pct: number | null = null;
    let holderCount: number | null = null;
    if (holdersResp.ok && supplyResp.ok) {
      const holdersBody = await holdersResp.json() as { result?: Array<{ TokenHolderQuantity?: string }> };
      const supplyBody  = await supplyResp.json()  as { result?: string };
      const totalSupply = parseFloat(supplyBody.result ?? "0");
      const holders     = holdersBody.result ?? [];
      holderCount = holders.length;
      if (totalSupply > 0 && holders.length >= 3) {
        const top3 = holders
          .slice(0, 3)
          .reduce((sum, h) => sum + parseFloat(h.TokenHolderQuantity ?? "0"), 0);
        top3Pct = (top3 / totalSupply) * 100;
      }
    }

    return { ageHours, top3Pct, holderCount };
  } catch {
    // Etherscan unavailable — fail open (don't drop the token on a network error)
    return { ageHours: null, top3Pct: null, holderCount: null };
  }
}

async function checkSolscan(address: string): Promise<AgeAndHolders> {
  const base = "https://public-api.solscan.io";

  try {
    const [metaResp, holdersResp] = await Promise.all([
      fetch(`${base}/token/meta?tokenAddress=${address}`,                           { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }),
      fetch(`${base}/token/holders?tokenAddress=${address}&limit=10&offset=0`,      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }),
    ]);

    // Age
    let ageHours: number | null = null;
    if (metaResp.ok) {
      const body = await metaResp.json() as { tokenInfo?: { tokenCreatedAt?: number } };
      const createdAt = body.tokenInfo?.tokenCreatedAt;
      if (createdAt) ageHours = (Date.now() / 1000 - createdAt) / 3600;
    }

    // Holder concentration
    let top3Pct: number | null = null;
    let holderCount: number | null = null;
    if (holdersResp.ok) {
      const body = await holdersResp.json() as {
        total?: number;
        data?: Array<{ amount?: number; decimals?: number }>;
      };
      holderCount = body.total ?? null;
      const holders = body.data ?? [];
      if (holders.length >= 3) {
        const amounts = holders.map((h) => h.amount ?? 0);
        const totalInList = amounts.reduce((a, b) => a + b, 0);
        if (totalInList > 0) {
          const top3 = amounts.slice(0, 3).reduce((a, b) => a + b, 0);
          // Use list total as proxy for supply — conservative estimate
          top3Pct = (top3 / totalInList) * 100;
        }
      }
    }

    return { ageHours, top3Pct, holderCount };
  } catch {
    return { ageHours: null, top3Pct: null, holderCount: null };
  }
}

// ─── GDELT rate-limit gate ────────────────────────────────────────────────────
// GDELT returns 429 when multiple processCandidate() calls fire in parallel and
// all hit GDELT simultaneously. One slot per 2 seconds keeps us safely within
// their undocumented rate limit. JS is single-threaded so the read+write is atomic.
let gdeltLastCallAt = 0;
const GDELT_COOLDOWN_MS = 30_000; // one slot per full polling cycle — prevents burst 429s

// ─── Fear & Greed Index (cached) ──────────────────────────────────────────────
// Alternative.me publishes a market-wide sentiment index every 24h. We cache it
// for 15 minutes so the polling loop never hammers the endpoint. Extreme greed
// bumps the narrative multiplier; extreme fear cuts it.
let fearGreedCache: { value: number; expiresAt: number } | null = null;

async function getFearGreedIndex(): Promise<number> {
  if (fearGreedCache && Date.now() < fearGreedCache.expiresAt) return fearGreedCache.value;
  try {
    const resp = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const body = await resp.json() as { data?: Array<{ value?: string }> };
      const value = parseInt(body.data?.[0]?.value ?? "50", 10);
      fearGreedCache = { value, expiresAt: Date.now() + 15 * 60 * 1_000 };
      return value;
    }
  } catch { /* fall through */ }
  return 50; // neutral when unreachable
}

// ─── Trend signal source checks ────────────────────────────────────────────────
// Each returns true if it found any mention of the ticker in the source.
// All fail open — a network error returns false so we never drop a token
// just because a trend source went down.

// GDELT 2.0 — 250k+ global news sources, updated every 15 minutes, no key needed.
// Tries each term in parallel and returns true on the first hit.
// timespan=6h catches tokens trending over hours, not just the last 15 minutes.
async function checkGdelt(terms: string[]): Promise<boolean> {
  // One GDELT slot per 2 seconds across all concurrent processCandidate() calls.
  const now = Date.now();
  if (now - gdeltLastCallAt < GDELT_COOLDOWN_MS) return false;
  gdeltLastCallAt = now;

  const results = await Promise.allSettled(
    terms.map(async (term) => {
      try {
        const q = encodeURIComponent(`"${term}"`);
        const resp = await fetch(
          `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=5&timespan=6h&format=json`,
          { signal: AbortSignal.timeout(8_000) },
        );
        if (!resp.ok) {
          console.log(`[research] GDELT "${term}": HTTP ${resp.status}`);
          return false;
        }
        const body = await resp.json() as { articles?: unknown[] };
        const count = body.articles?.length ?? 0;
        if (count > 0 || process.env["DEBUG_TREND"]) {
          console.log(`[research] GDELT "${term}": ${count} article(s)`);
        }
        return count > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.some((r) => r.status === "fulfilled" && r.value);
}

// Eight curated RSS feeds: CoinDesk, CoinTelegraph, Decrypt, The Defiant,
// CoinJournal, The Block, Reuters business, BBC business. Fetched in parallel;
// a simple case-insensitive substring scan checks for any search term.
// No XML parser needed — the ticker appears in title/description as plain text.
const RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://thedefiant.io/feed",
  "https://coinjournal.net/feed/",
  "https://www.theblock.co/rss.xml",
  "https://feeds.reuters.com/reuters/businessNews",
  "http://feeds.bbci.co.uk/news/business/rss.xml",
] as const;

async function checkRssFeeds(terms: string[]): Promise<boolean> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map((url) =>
      fetch(url, {
        headers: { "User-Agent": "hawkeye-research-agent/0.1" },
        signal: AbortSignal.timeout(6_000),
      }).then((r) => (r.ok ? r.text() : "")),
    ),
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const text = result.value.toLowerCase();
    if (terms.some((t) => text.includes(t.toLowerCase()))) return true;
  }
  return false;
}

// Stocktwits — real-time trading community discussion, public API, no key needed.
// Tries each term so TRUMP28 also checks TRUMP, etc.
async function checkStocktwits(terms: string[]): Promise<boolean> {
  const results = await Promise.allSettled(
    terms.map(async (term) => {
      try {
        const resp = await fetch(
          `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(term)}.json`,
          { signal: AbortSignal.timeout(6_000) },
        );
        if (!resp.ok) return false;
        const body = await resp.json() as { messages?: unknown[] };
        return (body.messages?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.some((r) => r.status === "fulfilled" && r.value);
}


// ─── Reddit multi-subreddit signal ────────────────────────────────────────────
// Searches 23 subreddits in one request (Reddit's + path syntax).
// Split into two groups so the intent is clear: crypto-native discussion vs.
// real-world narrative (e.g. a "World Cup" token benefits when r/soccer is
// buzzing about the actual World Cup — the narrative drives token demand).
// Each subreddit that has ≥1 qualifying post (within 48h, ups ≥ 3) adds one
// entry to sources[], so Reddit can contribute multiple signal points.
const REDDIT_CRYPTO_SUBS = [
  "CryptoCurrency", "CryptoMoonShots", "DeFi", "SatoshiStreetBets",
  "CryptoMarkets", "memecoin", "solana", "ethereum", "BSCMoonShots",
  "CryptoNews", "altcoin",
] as const;

const REDDIT_NEWS_SUBS = [
  "worldnews", "news", "geopolitics", "investing", "finance",
  "Economics", "sports", "soccer", "technology", "Futurology",
  "entertainment", "politics",
] as const;

async function checkReddit(ticker: string, tokenName: string): Promise<string[]> {
  const seenPostIds = new Set<string>();
  const matchedSubs = new Set<string>();
  const nowSec      = Date.now() / 1000;
  const cutoff48h   = nowSec - 48 * 3600;

  // Shared fetch + filter logic — closure over seenPostIds and matchedSubs.
  async function processUrl(url: string, minUps: number, label: string): Promise<void> {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "hawkeye-research-agent/0.1" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        console.log(`[research] Reddit "${label}": HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json() as {
        data?: { children?: Array<{ data: {
          name: string; subreddit: string; ups: number; created_utc: number; title: string;
        } }> };
      };
      for (const child of body.data?.children ?? []) {
        const post = child.data;
        if (seenPostIds.has(post.name)) continue;
        seenPostIds.add(post.name);
        if (post.created_utc > cutoff48h && post.ups >= minUps) {
          matchedSubs.add(post.subreddit);
          console.log(`[research] Reddit hit r/${post.subreddit} ups=${post.ups} [q="${label}"]: "${post.title.slice(0, 60)}"`);
        }
      }
    } catch { /* fail open */ }
  }

  const cryptoPath = REDDIT_CRYPTO_SUBS.join("+");
  const newsPath   = REDDIT_NEWS_SUBS.join("+");
  const requests: Promise<void>[] = [];

  // Crypto subreddits — full text search, low upvote bar.
  // Short tickers (≤4 chars) are common words — only search dollar-prefix so
  // "BULL" doesn't match every post body that says "bullish" or "bull run".
  // Longer tickers try both bare and dollar-prefix since ambiguity is low.
  const cryptoQueries = ticker.length <= 4 ? [`$${ticker}`] : [ticker, `$${ticker}`];
  for (const q of cryptoQueries) {
    requests.push(processUrl(
      `https://www.reddit.com/r/${cryptoPath}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=25`,
      3, q,
    ));
  }

  // News subreddits — title-only quoted phrase search, higher upvote bar.
  // Uses the full token name (e.g. "World Cup") not the ticker, so only posts whose
  // headline explicitly references the theme will count. Guards:
  //   • name ≥ 5 chars — prevents single-letter or generic 3-letter names matching noise
  //   • name ≠ ticker  — avoids running a redundant search already covered by crypto subs
  const namePhrase = tokenName.trim();
  if (namePhrase.length >= 5 && namePhrase.toLowerCase() !== ticker.toLowerCase()) {
    requests.push(processUrl(
      `https://www.reddit.com/r/${newsPath}/search.json?q=${encodeURIComponent(`title:"${namePhrase}"`)}&restrict_sr=1&sort=new&limit=25`,
      10, `title:"${namePhrase}"`,
    ));
  }

  await Promise.allSettled(requests);
  return [...matchedSubs];
}

// Tavily — deep search fallback. Called only on PARTIAL signal (exactly 1 free
// source fires) in the polling loop. Always called in RESEARCH_REQUEST (Commit 5).
// Requires TAVILY_API_KEY.
// days=3 for polling loop (fresh signal only), days=7 for RESEARCH_REQUEST (more context).
async function checkTavily(ticker: string, days = 3): Promise<boolean> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key) return false;
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: `${ticker} crypto token`,
        search_depth: "basic",
        max_results: 5,
        days,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const body = await resp.json() as { results?: unknown[] };
    return (body.results?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ─── Trend signal aggregator ───────────────────────────────────────────────────
type TrendSignal = {
  mentionCount: number; // sources that returned a positive hit
  sources: string[];    // names of those sources (for the ALPHA_FOUND reason string)
  fearGreed: number;    // 0–100 market-wide index from Alternative.me
};

// Build a de-duplicated list of search terms from a ticker + name.
// TRUMP28 → ["TRUMP28", "TRUMP"]  (strip trailing digits)
// 1INCH   → ["1INCH", "INCH"]     (strip leading digits)
// "Chad House" → adds "Chad", "House" as individual words (≥4 chars)
function expandSearchTerms(ticker: string, tokenName: string): string[] {
  const terms = new Set<string>([ticker]);
  const stripped = ticker.replace(/^\d+|\d+$/, "").trim();
  if (stripped.length >= 3 && stripped !== ticker) terms.add(stripped);
  for (const word of tokenName.split(/\s+/)) {
    if (word.length >= 4) terms.add(word);
  }
  return [...terms];
}

// withGdelt=false for the polling loop (GDELT 429s under parallel load).
// withGdelt=true for RESEARCH_REQUEST — user-triggered, rare, worth the call.
async function checkTrendSignal(
  ticker: string,
  tokenName: string,
  withGdelt = false,
): Promise<TrendSignal> {
  const terms    = expandSearchTerms(ticker, tokenName);
  // Short tickers (≤4 chars) are common English words — "BULL", "MOON", "PUMP".
  // Require dollar-prefix in RSS so "bull market" articles don't register as signal.
  const rssTerms = [...new Set([...terms, tokenName])]
    .filter((t) => t.length >= 2)
    .map((t) => t.length <= 4 ? `$${t}` : t);

  // Neynar cast search requires a paid plan (HTTP 402 on free tier).
  // Re-enable checkNeynar() here once the plan is upgraded.
  // Reddit replaces Neynar: each matched subreddit adds one signal point.
  const [gdelt, rss, stocktwits, reddit, fearGreed] = await Promise.allSettled([
    withGdelt ? checkGdelt(terms) : Promise.resolve(false),
    checkRssFeeds(rssTerms),
    checkStocktwits(terms),
    checkReddit(ticker, tokenName),
    getFearGreedIndex(),
  ]);

  const sources: string[] = [];
  if (gdelt.status      === "fulfilled" && gdelt.value)      sources.push("gdelt");
  if (rss.status        === "fulfilled" && rss.value)        sources.push("rss");
  if (stocktwits.status === "fulfilled" && stocktwits.value) sources.push("stocktwits");
  if (reddit.status     === "fulfilled") {
    for (const sub of reddit.value) sources.push(`reddit/${sub}`);
  }

  const fg = fearGreed.status === "fulfilled" ? fearGreed.value : 50;
  return { mentionCount: sources.length, sources, fearGreed: fg };
}

// ─── Narrative multiplier ──────────────────────────────────────────────────────
// Converts trend strength into a safetyScore multiplier (1.0x–1.8x).
// More independent sources = stronger signal = higher ceiling.
// Fear & Greed modulates by ±0.1 at the extremes (greed up, fear down).
function computeNarrativeMultiplier(signal: TrendSignal): number {
  let base: number;
  if (signal.mentionCount >= 3)       base = 1.7;
  else if (signal.mentionCount === 2) base = 1.4;
  else if (signal.mentionCount === 1) base = 1.15;
  else                                base = 1.0;

  let fgAdjust = 0;
  if (signal.fearGreed >= 75)      fgAdjust =  0.1;
  else if (signal.fearGreed <= 25) fgAdjust = -0.1;

  return Math.min(1.8, Math.max(1.0, base + fgAdjust));
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

    const volLiqRatio = liquidityUsd > 0 ? volume24h / liquidityUsd : 0;
    if (
      liquidityUsd < MIN_LIQUIDITY_USD ||
      volume24h    < MIN_VOLUME_24H    ||
      volLiqRatio  < MIN_VOL_LIQ_RATIO
    ) return;

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

    // ── Stage 3: holder/age intelligence ──────────────────────────────────────
    const ageAndHolders = await checkAgeAndHolders(address, chainClass, chainId);

    // Hard drop 3: token less than 1 hour old — too new, likely sniper bait.
    if (ageAndHolders.ageHours !== null && ageAndHolders.ageHours < 1) {
      console.log(`[research] drop ${ticker}: too new (${ageAndHolders.ageHours.toFixed(1)}h old)`);
      return;
    }

    // Hard drop 4: top 3 wallets hold > 80% of supply — coordinated dump setup.
    if (ageAndHolders.top3Pct !== null && ageAndHolders.top3Pct > 80) {
      console.log(`[research] drop ${ticker}: holder concentration ${ageAndHolders.top3Pct.toFixed(0)}%`);
      return;
    }

    // ── Stage 4: trend signal + narrative multiplier + ALPHA_FOUND ───────────
    // Industry acronyms skip trend entirely — searching "EVM", "NFT", "DAO"
    // generates false positives in every source by definition. They can still
    // pass via the fundamentals override below if metrics are strong enough.
    let trend: TrendSignal = { mentionCount: 0, sources: [], fearGreed: 50 };
    if (!INDUSTRY_TERM_TICKERS.has(ticker.toUpperCase())) {
      trend = await checkTrendSignal(ticker, tokenName);
      // PARTIAL signal: only 1 free source fired → use Tavily to confirm/amplify.
      // Avoids burning Tavily's quota on tokens with no signal at all.
      if (trend.mentionCount === 1) {
        const tavilyConfirmed = await checkTavily(ticker);
        if (tavilyConfirmed) trend.sources.push("tavily");
        trend.mentionCount = trend.sources.length;
      }
    }

    const multiplier       = computeNarrativeMultiplier(trend);
    const opportunityScore = Math.min(100, Math.round(safetyScore * multiplier));

    console.log(
      `[research] ${ticker} opportunity=${opportunityScore}` +
      ` (safety=${safetyScore}×${multiplier.toFixed(2)}) trend=[${trend.sources.join(",")}]`,
    );

    if (opportunityScore < ALPHA_THRESHOLD) return;

    // Require at least one trend signal — unless fundamentals are strong enough
    // to stand alone: ≥200 holders, ≥$150k liquidity, ≥$300k 24h volume.
    const fundamentalsOverride =
      (ageAndHolders.holderCount ?? 0) > 200 &&
      liquidityUsd > 150_000 &&
      volume24h    > 300_000;

    if (trend.sources.length === 0 && !fundamentalsOverride) {
      console.log(`[research] skip ${ticker}: no trend signal, fundamentals below override threshold`);
      return;
    }

    const reason =
      `${ticker} scored ${opportunityScore}/100 ` +
      `(safety ${safetyScore}, ${multiplier.toFixed(2)}x narrative boost). ` +
      (trend.sources.length > 0
        ? `Trend confirmed by: ${trend.sources.join(", ")}.`
        : "Passes all safety filters — no active trend signals.");

    void priceUsd; // available for Commit 5 ALPHA_FOUND extension if needed

    bus.emit("ALPHA_FOUND", {
      address,
      chainId: chainId as ChainId,
      safetyScore,
      liquidityUsd,
      reason,
      foundAt: Date.now(),
    } satisfies AlphaFoundPayload);

  } catch (err) {
    console.error(`[research] error processing ${address} (${chainId}):`, err);
  }
}

// ─── CoinGecko ────────────────────────────────────────────────────────────────
// Two-step: search by symbol → fetch full coin data. Free public API, no key.
// Called only for RESEARCH_REQUEST (user-triggered) to stay within the free rate limit.
type CoinGeckoData = {
  priceUsd:     number | null;
  marketCap:    number | null;
  volume24h:    number | null;
  sentimentUp:  number | null; // % of users who voted bullish
  sentimentDown: number | null;
};

async function fetchCoinGecko(ticker: string): Promise<CoinGeckoData | null> {
  const empty: CoinGeckoData = { priceUsd: null, marketCap: null, volume24h: null, sentimentUp: null, sentimentDown: null };
  try {
    const searchResp = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!searchResp.ok) return empty;
    const searchBody = await searchResp.json() as { coins?: Array<{ id: string; symbol: string }> };
    const coinId = searchBody.coins?.find(
      (c) => c.symbol.toLowerCase() === ticker.toLowerCase(),
    )?.id;
    if (!coinId) return empty;

    const coinResp = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}` +
      `?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!coinResp.ok) return empty;
    const coin = await coinResp.json() as {
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
      };
      sentiment_votes_up_percentage?: number;
      sentiment_votes_down_percentage?: number;
    };
    return {
      priceUsd:     coin.market_data?.current_price?.usd ?? null,
      marketCap:    coin.market_data?.market_cap?.usd ?? null,
      volume24h:    coin.market_data?.total_volume?.usd ?? null,
      sentimentUp:  coin.sentiment_votes_up_percentage ?? null,
      sentimentDown: coin.sentiment_votes_down_percentage ?? null,
    };
  } catch {
    return empty;
  }
}

// ─── Birdeye (Solana only) ────────────────────────────────────────────────────
// Enhanced Solana analytics — more accurate price/volume than DexScreener for SPL tokens.
// Only called when chainClass === "solana". Requires BIRDEYE_API_KEY.
type BirdeyeData = { priceUsd: number | null; volume24h: number | null };

async function fetchBirdeye(address: string): Promise<BirdeyeData | null> {
  const key = process.env["BIRDEYE_API_KEY"];
  if (!key) return null;
  try {
    const resp = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
      {
        headers: { "X-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!resp.ok) return null;
    const body = await resp.json() as { data?: { price?: number; v24hUSD?: number } };
    return { priceUsd: body.data?.price ?? null, volume24h: body.data?.v24hUSD ?? null };
  } catch {
    return null;
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────
// Reserved for RESEARCH_REQUEST — not the polling loop (2k/month free tier).
// Searches global + crypto-specific results for fresh context on the token.
type BraveResult = { title: string; description: string; url: string };

async function searchBrave(query: string): Promise<BraveResult[]> {
  const key = process.env["BRAVE_API_KEY"];
  if (!key) return [];
  try {
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) return [];
    const body = await resp.json() as {
      web?: { results?: Array<{ title?: string; description?: string; url?: string }> };
    };
    return (body.web?.results ?? []).map((r) => ({
      title:       r.title       ?? "",
      description: r.description ?? "",
      url:         r.url         ?? "",
    }));
  } catch {
    return [];
  }
}

// ─── LLM synthesis via 0G Compute ─────────────────────────────────────────────
// Uses OgComputeClient (src/integrations/0g/compute.ts). Requires HAWKEYE_EVM_PRIVATE_KEY.
// Lazy singleton — initialised on first call, reused for the process lifetime.
// Falls back to "" if the key is absent or inference fails; caller uses buildTemplateSummary().
let _ogClient: OgComputeClient | null = null;

function getOgClient(): OgComputeClient {
  if (!_ogClient) _ogClient = new OgComputeClient();
  return _ogClient;
}

async function callLLM(prompt: string): Promise<string> {
  if (!process.env["HAWKEYE_EVM_PRIVATE_KEY"]) return "";
  try {
    const resp = await getOgClient().infer({
      system: "You are a crypto research assistant. Give concise, direct verdicts on tokens.",
      user:   prompt,
      maxTokens: 250,
    });
    const result = resp.text.trim();
    if (!result) console.warn("[research] 0G Compute returned empty — falling back to template");
    return result;
  } catch (err) {
    console.error("[research] 0G Compute call failed:", err);
    return "";
  }
}

// ─── Prompt + fallback template ───────────────────────────────────────────────
type ResearchData = {
  ticker: string; tokenName: string; address: string; chainId: string;
  priceUsd: number | null; liquidityUsd: number | null;
  security: { flags: SafetyFlag[]; score: number; ok: boolean };
  age: AgeAndHolders;
  trend: TrendSignal;
  cg: CoinGeckoData | null;
  birdeye: BirdeyeData | null;
  brave: BraveResult[];
  opportunityScore: number;
  question: string;
};

function buildResearchPrompt(d: ResearchData): string {
  const lines = [
    `Token: ${d.ticker} (${d.tokenName}) on ${d.chainId}`,
    `Address: ${d.address}`,
    `Price: ${d.priceUsd != null ? `$${d.priceUsd}` : "unknown"}`,
    `Liquidity: ${d.liquidityUsd != null ? `$${d.liquidityUsd.toFixed(0)}` : "unknown"}`,
    `Safety score: ${d.security.score}/100`,
    `Flags: ${d.security.flags.length > 0 ? d.security.flags.join(", ") : "none"}`,
    `Age: ${d.age.ageHours != null ? `${d.age.ageHours.toFixed(0)}h` : "unknown"}`,
    `Top-3 holder concentration: ${d.age.top3Pct != null ? `${d.age.top3Pct.toFixed(0)}%` : "unknown"}`,
    `Trend signals: ${d.trend.sources.join(", ") || "none"} (Fear & Greed: ${d.trend.fearGreed}/100)`,
    `Opportunity score: ${d.opportunityScore}/100`,
  ];
  if (d.cg?.marketCap)    lines.push(`CoinGecko market cap: $${(d.cg.marketCap / 1e6).toFixed(1)}M`);
  if (d.cg?.sentimentUp)  lines.push(`CoinGecko sentiment: ${d.cg.sentimentUp.toFixed(0)}% bullish`);
  if (d.birdeye?.volume24h) lines.push(`Birdeye 24h volume: $${d.birdeye.volume24h.toFixed(0)}`);
  if (d.brave.length > 0) lines.push(`Web results: ${d.brave.slice(0, 3).map((r) => r.title).join(" | ")}`);
  lines.push(`\nUser question: ${d.question}`);
  lines.push("\nGive a concise 2-3 sentence verdict on this token. Be direct — mention the most important risk or opportunity. No filler.");
  return lines.join("\n");
}

function buildTemplateSummary(d: ResearchData): string {
  const risk  = d.security.flags.length > 0
    ? `Risk flags: ${d.security.flags.join(", ")}.`
    : "No major risk flags detected.";
  const trend = d.trend.sources.length > 0
    ? `Active mentions in: ${d.trend.sources.join(", ")}.`
    : "No trend signals detected.";
  const age   = d.age.ageHours != null ? `Token age: ${d.age.ageHours.toFixed(0)}h.` : "";
  return [
    `${d.ticker}: safety ${d.security.score}/100, opportunity ${d.opportunityScore}/100.`,
    risk, trend, age,
  ].filter(Boolean).join(" ");
}

// ─── RESEARCH_REQUEST handler ──────────────────────────────────────────────────
async function handleResearchRequest(req: ResearchRequest): Promise<void> {
  console.log(`[research] RESEARCH_REQUEST for ${req.address ?? req.tokenName ?? "unknown"}`);

  // ── 1. Resolve address ───────────────────────────────────────────────────────
  // If the user asked by ticker name instead of address, find it via DexScreener.
  let address = req.address;
  let resolvedChainId: DexScreenerChain = "ethereum";

  if (!address && req.tokenName) {
    const { pairs } = await searchPairs(req.tokenName, { limit: 5 }).catch(() => ({
      query: "", pairs: [] as DexPair[], note: "",
    }));
    const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (top && isValidChain(top.chainId)) {
      address        = top.baseToken.address;
      resolvedChainId = top.chainId as DexScreenerChain;
    }
  }

  if (!address) {
    console.log(`[research] could not resolve address for "${req.tokenName}"`);
    return;
  }

  const chainClass = detectChainClass(address);
  if (req.chain === "solana" || chainClass === "solana") resolvedChainId = "solana";

  // ── 2. DexScreener — canonical pair data ────────────────────────────────────
  const pairs = await getPairsByToken(resolvedChainId, address).catch(() => [] as DexPair[]);
  const best  = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  const ticker      = best?.baseToken?.symbol ?? req.tokenName ?? address.slice(0, 8);
  const tokenName   = best?.baseToken?.name   ?? req.tokenName ?? ticker;
  const priceUsd    = parseFloat(best?.priceUsd ?? "0") || null;
  const liquidityUsd = best?.liquidity?.usd    ?? null;

  // ── 3. All sources in parallel ───────────────────────────────────────────────
  const [secS, ageS, trendS, cgS, birdS, braveS] = await Promise.allSettled([
    runSecurityScan(address, chainClass, resolvedChainId),
    checkAgeAndHolders(address, chainClass, resolvedChainId),
    checkTrendSignal(ticker, tokenName, true), // withGdelt=true — user-triggered, low frequency
    fetchCoinGecko(ticker),
    chainClass === "solana" ? fetchBirdeye(address) : Promise.resolve(null),
    searchBrave(`${ticker} ${tokenName} crypto`),
  ]);

  const security = secS.status   === "fulfilled" ? secS.value   : { flags: [] as SafetyFlag[], score: 50, ok: false };
  const age      = ageS.status   === "fulfilled" ? ageS.value   : { ageHours: null, top3Pct: null, holderCount: null };
  const trend    = trendS.status === "fulfilled" ? trendS.value : { mentionCount: 0, sources: [] as string[], fearGreed: 50 };
  const cg       = cgS.status    === "fulfilled" ? cgS.value    : null;
  const birdeye  = birdS.status  === "fulfilled" ? birdS.value  : null;
  const brave    = braveS.status === "fulfilled" ? braveS.value : [];

  // Tavily always fires for RESEARCH_REQUEST — unlike the polling loop it's
  // user-initiated so spending a quota call here is always justified.
  // 7-day window gives more context than the polling loop's 3-day fresh-signal filter.
  const tavilyHit = await checkTavily(ticker, 7);
  if (tavilyHit && !trend.sources.includes("tavily")) {
    trend.sources.push("tavily");
    trend.mentionCount++;
  }

  const multiplier      = computeNarrativeMultiplier(trend);
  const opportunityScore = Math.min(100, Math.round(security.score * multiplier));

  // ── 4. LLM synthesis → template fallback ────────────────────────────────────
  const data: ResearchData = {
    ticker, tokenName, address,
    chainId: resolvedChainId,
    priceUsd, liquidityUsd,
    security, age, trend, cg, birdeye, brave,
    opportunityScore,
    question: req.question,
  };

  let summary = await callLLM(buildResearchPrompt(data));
  if (!summary) summary = buildTemplateSummary(data);

  bus.emit("RESEARCH_RESULT", {
    requestId:   req.requestId,
    address,
    chain:       chainClass,
    summary,
    safetyScore: security.score,
    priceUsd,
    liquidityUsd,
    flags:       security.flags,
    completedAt: Date.now(),
  } satisfies ResearchResult);

  console.log(`[research] RESEARCH_RESULT emitted for ${ticker} (opportunity=${opportunityScore})`);
}

// ─── Agent entry point ─────────────────────────────────────────────────────────
/**
 * Starts the Research Agent. Call once from src/index.ts at boot time.
 *
 * Job 1: background polling loop — emits ALPHA_FOUND for tokens that pass all gates.
 * Job 2: RESEARCH_REQUEST listener — emits RESEARCH_RESULT with LLM-synthesised verdict.
 *
 * Keys required (add to .env.local — never committed):
 *   HAWKEYE_EVM_PRIVATE_KEY — 0G Compute wallet for LLM inference
 *   ETHERSCAN_API_KEY, BIRDEYE_API_KEY, BRAVE_API_KEY,
 *   TAVILY_API_KEY, NEYNAR_API_KEY (upgrade to paid for cast search)
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
