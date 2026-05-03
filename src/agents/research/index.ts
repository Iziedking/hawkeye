// Research Agent — discovers alpha tokens (background loop) and answers research questions.
//
// Job 1 — Background discovery loop (fires every 30 seconds):
//   Polls DexScreener for new/trending tokens → security scan → holder/age intelligence
//   → trend signal → narrative multiplier → emits ALPHA_FOUND for anything that passes.
//
// Job 2 — Research request handler (event-driven):
//   Gateway emits RESEARCH_REQUEST when a user asks about a token.
//   Agent pulls full data from all sources, synthesises a verdict via the injected LLM
//   (or OgComputeClient fallback), emits RESEARCH_RESULT.
//
// Source stack:
//   Security   : GoPlus (EVM), Honeypot.is (EVM), RugCheck (Solana)
//   Market     : DexScreener, CoinGecko, Birdeye (Solana)
//   Holders    : Etherscan (EVM), Solscan (Solana)
//   Sentiment  : Alternative.me Fear & Greed Index
//   Trend      : GDELT (250k+ global news, no key), RSS feeds, Stocktwits,
//                Reddit (23 subreddits — crypto + news/world), Tavily
//   Synthesis  : Injected LlmClient (Israel's FallbackLlmClient) → OgComputeClient fallback

import { bus } from "../../shared/event-bus";
import { log } from "../../shared/logger";
import type {
  AlphaFoundPayload,
  ResearchRequest,
  ResearchResult,
  ResearchSubIntent,
  ChainId,
  SafetyFlag,
  LlmClient,
} from "../../shared/types";
import { OgComputeClient } from "../../integrations/0g/compute";
import { ArkhamClient } from "../../integrations/arkham/index";
import type { ArkhamHolder, ArkhamFlow } from "../../integrations/arkham/index";
import { NansenClient } from "../../integrations/nansen/index";
import type { NansenFlows as NansenFlowsImported } from "../../integrations/nansen/index";
import {
  getLatestTokenProfiles,
  getLatestBoosts,
  getPairsByToken,
  searchPairs,
  isValidChain,
} from "../../tools/dexscreener-mcp/client";
import type { DexPair, DexScreenerChain } from "../../tools/dexscreener-mcp/client";

function formatCompact(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const CHAIN_KEYWORDS: Record<string, string> = {
  ethereum: "ethereum",
  eth: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  optimism: "optimism",
  op: "optimism",
  polygon: "polygon",
  matic: "polygon",
  bsc: "bsc",
  bnb: "bsc",
  binance: "bsc",
  avalanche: "avalanche",
  avax: "avalanche",
  blast: "blast",
  scroll: "scroll",
  linea: "linea",
  mantle: "mantle",
  zksync: "zksync",
  solana: "solana",
  sol: "solana",
};

function detectChainFromText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [kw, cid] of Object.entries(CHAIN_KEYWORDS)) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) return cid;
  }
  return null;
}

function detectChainsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [kw, cid] of Object.entries(CHAIN_KEYWORDS)) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) found.add(cid);
  }
  return [...found];
}

const COINGECKO_CHAIN_CATEGORIES: Record<string, string[]> = {
  base: ["base-meme-coins"],
  bsc: ["bnb-chain-meme-coins"],
  solana: ["solana-meme-coins"],
  ethereum: ["meme-token"],
  arbitrum: ["meme-token"],
  polygon: ["meme-token"],
  optimism: ["meme-token"],
  avalanche: ["meme-token"],
};

const TRENDING_EXCLUDE_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "BUSD",
  "TUSD",
  "USDP",
  "GUSD",
  "FRAX",
  "LUSD",
  "USDE",
  "USD1",
  "USDB",
  "USDBC",
  "SUSDE",
  "EURC",
  "RUSD",
  "PYUSD",
  "WETH",
  "WBNB",
  "WBTC",
  "WMATIC",
  "WAVAX",
  "WSOL",
  "WFTM",
  "WCRO",
  "ETH",
  "BTC",
  "BNB",
  "SOL",
  "MATIC",
  "AVAX",
  "FTM",
  "DOT",
  "ADA",
  "XRP",
  "LINK",
  "UNI",
  "AAVE",
  "CBBTC",
  "STETH",
  "RETH",
  "CBETH",
]);

type CoinGeckoMarketItem = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  price_change_percentage_24h: number | null;
  fully_diluted_valuation: number | null;
};

async function fetchCoinGeckoTrending(
  chain: string,
  limit: number,
): Promise<CoinGeckoMarketItem[]> {
  const categories = COINGECKO_CHAIN_CATEGORIES[chain];
  if (!categories) return [];
  const results: CoinGeckoMarketItem[] = [];
  for (const cat of categories) {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${limit}&page=1&category=${cat}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) continue;
      const data = (await resp.json()) as CoinGeckoMarketItem[];
      if (Array.isArray(data)) results.push(...data);
    } catch {
      /* rate limited or timeout */
    }
  }
  const seen = new Set<string>();
  return results
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (TRENDING_EXCLUDE_SYMBOLS.has(c.symbol.toUpperCase())) return false;
      if ((c.total_volume ?? 0) < 10_000) return false;
      return true;
    })
    .sort((a, b) => (b.total_volume ?? 0) - (a.total_volume ?? 0))
    .slice(0, limit);
}

// Tickers that are industry-standard acronyms (EVM, NFT, DAO, etc.).
// These generate structural false positives in every RSS/Reddit/news search by
// design — skip trend signal for them entirely. They can still pass via the
// fundamentals override if metrics are strong enough.
const INDUSTRY_TERM_TICKERS = new Set([
  "EVM",
  "NFT",
  "DAO",
  "TVL",
  "DEX",
  "CEX",
  "APY",
  "APR",
  "L1",
  "L2",
  "TPS",
  "MEV",
  "RPC",
  "ABI",
  "ERC",
  "BEP",
  "SPL",
  "DeFi",
  "DEFI",
  "AMM",
  "LP",
  "VC",
]);

const POLL_INTERVAL_MS = 30_000;
const MIN_LIQUIDITY_USD = 50_000;
const MIN_VOLUME_24H = 120_000;
const MIN_VOL_LIQ_RATIO = 2;
const ALPHA_THRESHOLD = 65;

// ─── Seen token registry ───────────────────────────────────────────────────────
// Prevents re-processing the same address across polling cycles.
// Key: "${chainId}:${address.toLowerCase()}" → timestamp first seen (ms).
// Entries expire after 4 hours so tokens get re-evaluated if they resurface later.
const SEEN_TOKEN_TTL_MS = 4 * 60 * 60 * 1_000;
const seenTokens = new Map<string, number>();
let _pollingArkham: ArkhamClient | undefined;

// ─── Etherscan rate limiter ────────────────────────────────────────────────────
// Serialises all Etherscan fetches to ≤2 calls/sec so polling and research
// requests never collide regardless of concurrency.
let _etherscanLastCallAt = 0;
const _etherscanQueue: Array<() => void> = [];
let _etherscanDraining = false;

async function _drainEtherscanQueue(): Promise<void> {
  if (_etherscanDraining) return;
  _etherscanDraining = true;
  while (_etherscanQueue.length > 0) {
    const gap = Date.now() - _etherscanLastCallAt;
    if (gap < 500) await new Promise((r) => setTimeout(r, 500 - gap));
    _etherscanLastCallAt = Date.now();
    _etherscanQueue.shift()?.();
  }
  _etherscanDraining = false;
}

function etherscanFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    _etherscanQueue.push(() => {
      fetch(url, init).then(resolve).catch(reject);
    });
    void _drainEtherscanQueue();
  });
}

// ─── Chain class helper ────────────────────────────────────────────────────────
function detectChainClass(address: string): "evm" | "solana" {
  return address.startsWith("0x") ? "evm" : "solana";
}

// ─── Security scanning ────────────────────────────────────────────────────────
// Intentionally duplicated from safety/index.ts — agents don't import each other.
// Same scoring so ALPHA_FOUND safetyScore and SAFETY_RESULT score are always comparable.

const CHAIN_NUMERIC_ID: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  avalanche: 43114,
  fantom: 250,
  cronos: 25,
  zksync: 324,
  linea: 59144,
  blast: 81457,
  scroll: 534352,
  mantle: 5000,
  celo: 42220,
  ronin: 2020,
  unichain: 130,
  gnosis: 100,
  berachain: 80094,
  hyperevm: 999,
  monad: 41454,
  mode: 34443,
  worldchain: 480,
};

const FLAG_DEDUCTIONS: Partial<Record<SafetyFlag, number>> = {
  HONEYPOT: 100,
  KNOWN_RUGGER: 50,
  PHISHING_ORIGIN: 30,
  MINT_AUTHORITY: 25,
  FREEZE_AUTHORITY: 25,
  HIGH_TAX: 25,
  BLACKLIST: 20,
  LOW_LIQUIDITY: 20,
  NO_VOLUME: 20,
  UNVERIFIED_CONTRACT: 15,
  CONCENTRATED_SUPPLY: 15,
  PROXY_CONTRACT: 10,
  VERY_NEW: 10,
};

// Weighted scoring — single-source flags are discounted by source reliability.
// HONEYPOT always gets full deduction regardless of source.
type FlagSource = "goplus" | "honeypot" | "rugcheck" | "goplusSolana" | "dexscreener" | "etherscan";
type FlagWithSource = { flag: SafetyFlag; source: FlagSource };

const SOURCE_WEIGHTS: Record<FlagSource, number> = {
  goplus: 0.9,
  honeypot: 0.85,
  rugcheck: 0.85,
  goplusSolana: 0.85,
  dexscreener: 1.0,
  etherscan: 0.9,
};

const GOPLUS_RETRY_DELAYS_MS = [1_000, 2_000] as const;

function computeScore(
  flagsWithSources: FlagWithSource[],
  jupiterBonus = false,
): { score: number; flags: SafetyFlag[] } {
  const flagSources = new Map<SafetyFlag, Set<FlagSource>>();
  for (const { flag, source } of flagsWithSources) {
    if (!flagSources.has(flag)) flagSources.set(flag, new Set());
    flagSources.get(flag)!.add(source);
  }
  let deduction = 0;
  for (const [flag, sources] of flagSources) {
    const base = FLAG_DEDUCTIONS[flag] ?? 0;
    if (flag === "HONEYPOT" || sources.size >= 2) {
      deduction += base;
    } else {
      const onlySource = [...sources][0] as FlagSource;
      deduction += base * (SOURCE_WEIGHTS[onlySource] ?? 1.0);
    }
  }
  if (jupiterBonus) deduction -= 5;
  return {
    score: Math.max(0, Math.round(100 - deduction)),
    flags: [...flagSources.keys()],
  };
}

function buildMarketFlags(
  liquidityUsd: number | null,
  volume24h: number | null,
  pairAgeHours: number | null,
  top3Pct: number | null,
): FlagWithSource[] {
  const flags: FlagWithSource[] = [];
  if (liquidityUsd !== null && liquidityUsd < 10_000) {
    flags.push({ flag: "LOW_LIQUIDITY", source: "dexscreener" });
  }
  if (pairAgeHours !== null && pairAgeHours < 1) {
    flags.push({ flag: "VERY_NEW", source: "dexscreener" });
  }
  if (volume24h !== null && volume24h === 0) {
    flags.push({ flag: "NO_VOLUME", source: "dexscreener" });
  }
  if (top3Pct !== null && top3Pct > 50) {
    flags.push({ flag: "CONCENTRATED_SUPPLY", source: "etherscan" });
  }
  return flags;
}

const TOOL_DEFAULTS: Record<ResearchSubIntent, string[]> = {
  TOKEN_LOOKUP: ["dexscreener", "goplus", "coingecko", "etherscan"],
  WHALE_ANALYSIS: ["arkham", "etherscan", "nansen", "dexscreener", "dune"],
  TRENDING: ["dexscreener", "coingecko", "arkham_trending"],
  MARKET_OVERVIEW: ["coingecko", "feargreed"],
  CATEGORY: ["coingecko", "dexscreener"],
  SAFETY_CHECK: ["goplus", "honeypot", "etherscan", "dexscreener"],
  PRICE_ACTION: ["dexscreener", "coingecko", "geckoterminal"],
  RESEARCH_WALLET: ["arkham"],
};

let goplusToken: { token: string; expiresAt: number } | null = null;

async function getGoPlusAccessToken(): Promise<string | null> {
  if (goplusToken && Date.now() < goplusToken.expiresAt) return goplusToken.token;
  const key = process.env["GOPLUS_API_KEY"] ?? "";
  const secret = process.env["GOPLUS_API_SECRET"] ?? "";
  if (!key || !secret) return null;
  try {
    const resp = await fetch("https://api.gopluslabs.io/api/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: key, app_secret: secret }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { result?: { access_token?: string; expires_in?: number } };
    const token = body.result?.access_token;
    if (!token) return null;
    const ttl = (body.result?.expires_in ?? 3600) * 1000;
    goplusToken = { token, expiresAt: Date.now() + ttl - 60_000 };
    return token;
  } catch {
    return null;
  }
}

async function getGoPlusHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await getGoPlusAccessToken();
  if (token) headers["Authorization"] = token;
  return headers;
}

async function fetchGoPlusEVM(address: string, numericChainId: number): Promise<Response | null> {
  const url =
    `https://api.gopluslabs.io/api/v1/token_security/${numericChainId}` +
    `?contract_addresses=${address.toLowerCase()}`;
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= GOPLUS_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = GOPLUS_RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      console.warn(
        `[research] GoPlus 429 chain=${numericChainId} — retry ${attempt} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const hdrs = await getGoPlusHeaders();
      const resp = await fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.status === 429 && attempt < GOPLUS_RETRY_DELAYS_MS.length) {
        lastResp = resp;
        continue;
      }
      return resp;
    } catch {
      return null;
    }
  }
  if (lastResp?.status === 429)
    console.warn(`[research] GoPlus all retries exhausted chain=${numericChainId} — failing open`);
  return lastResp;
}

// GoPlus Solana — dedicated endpoint with different fields from the EVM endpoint.
// Solana addresses are base58 case-sensitive — do NOT .toLowerCase() the key lookup.
type GoPlusSolanaData = {
  is_mintable?: string;
  freezeable?: string;
  metadata_upgradeable?: string;
  transfer_fee_enable?: string;
  transfer_fee_rate?: string;
  hidden_owner?: string;
};

async function fetchGoPlusSolana(mintAddress: string): Promise<FlagWithSource[]> {
  const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mintAddress}`;
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= GOPLUS_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = GOPLUS_RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      console.warn(`[research] GoPlus Solana 429 — retry ${attempt} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const hdrs = await getGoPlusHeaders();
      const resp = await fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.status === 429 && attempt < GOPLUS_RETRY_DELAYS_MS.length) {
        lastResp = resp;
        continue;
      }
      lastResp = resp;
      break;
    } catch {
      return [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }];
    }
  }
  if (!lastResp?.ok) return [];
  try {
    const body = (await lastResp.json()) as { result?: Record<string, GoPlusSolanaData> };
    const data = body.result?.[mintAddress] ?? null;
    if (!data) return [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }];
    const flags: FlagWithSource[] = [];
    if (data.freezeable === "1") flags.push({ flag: "FREEZE_AUTHORITY", source: "goplusSolana" });
    if (data.is_mintable === "1") flags.push({ flag: "MINT_AUTHORITY", source: "goplusSolana" });
    if (parseFloat(data.transfer_fee_rate ?? "0") > 0.1)
      flags.push({ flag: "HIGH_TAX", source: "goplusSolana" });
    return flags;
  } catch {
    return [];
  }
}

// Jupiter strict token list — vetted tokens get a -5 deduction bonus.
const JUPITER_STRICT_TTL_MS = 60 * 60 * 1_000;
let jupiterStrictCache: { mints: Set<string>; expiresAt: number } | null = null;

async function isOnJupiterStrictList(mintAddress: string): Promise<boolean> {
  if (jupiterStrictCache && Date.now() < jupiterStrictCache.expiresAt) {
    return jupiterStrictCache.mints.has(mintAddress);
  }
  try {
    const resp = await fetch("https://token.jup.ag/strict", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return false;
    const tokens = (await resp.json()) as Array<{ address: string }>;
    const mints = new Set(tokens.map((t) => t.address));
    jupiterStrictCache = { mints, expiresAt: Date.now() + JUPITER_STRICT_TTL_MS };
    return mints.has(mintAddress);
  } catch {
    return false;
  }
}

async function runSecurityScan(
  address: string,
  chainClass: "evm" | "solana",
  chainId: string,
): Promise<{ flags: SafetyFlag[]; score: number; ok: boolean }> {
  const allFlags: FlagWithSource[] = [];
  let ok = true;

  if (chainClass === "evm") {
    const numericId = CHAIN_NUMERIC_ID[chainId] ?? 1;

    const [goplusResp, honeypotResp] = await Promise.allSettled([
      fetchGoPlusEVM(address, numericId),
      fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${numericId}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      }),
    ]);

    if (goplusResp.status === "fulfilled" && goplusResp.value?.ok) {
      const body = (await goplusResp.value.json()) as {
        result?: Record<string, Record<string, string>>;
      };
      const data = body.result?.[address.toLowerCase()];
      if (data) {
        if (data["is_honeypot"] === "1") allFlags.push({ flag: "HONEYPOT", source: "goplus" });
        if (data["is_mintable"] === "1")
          allFlags.push({ flag: "MINT_AUTHORITY", source: "goplus" });
        if (data["is_proxy"] === "1") allFlags.push({ flag: "PROXY_CONTRACT", source: "goplus" });
        if (data["is_blacklisted"] === "1") allFlags.push({ flag: "BLACKLIST", source: "goplus" });
        if (data["is_open_source"] !== "1")
          allFlags.push({ flag: "UNVERIFIED_CONTRACT", source: "goplus" });
        if (data["honeypot_with_same_creator"] === "1")
          allFlags.push({ flag: "KNOWN_RUGGER", source: "goplus" });
        const buyTax = parseFloat(data["buy_tax"] ?? "0");
        const sellTax = parseFloat(data["sell_tax"] ?? "0");
        if (buyTax > 0.1 || sellTax > 0.1) allFlags.push({ flag: "HIGH_TAX", source: "goplus" });
      } else {
        allFlags.push({ flag: "UNVERIFIED_CONTRACT", source: "goplus" });
        ok = false;
      }
    } else {
      allFlags.push({ flag: "UNVERIFIED_CONTRACT", source: "goplus" });
      ok = false;
    }

    if (honeypotResp.status === "fulfilled" && honeypotResp.value.ok) {
      const body = (await honeypotResp.value.json()) as { isHoneypot?: boolean };
      if (body.isHoneypot) allFlags.push({ flag: "HONEYPOT", source: "honeypot" });
    }
  } else {
    // Solana: RugCheck + GoPlus Solana in parallel for dual-scanner coverage.
    const [rugcheckResp, goplusSolFlags, onStrict] = await Promise.all([
      fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null),
      fetchGoPlusSolana(address),
      isOnJupiterStrictList(address),
    ]);

    if (rugcheckResp?.ok) {
      const report = (await rugcheckResp.json()) as {
        freezeAuthority?: string | null;
        mintAuthority?: string | null;
        risks?: Array<{ name: string; level?: string }>;
      };
      if (report.freezeAuthority) allFlags.push({ flag: "FREEZE_AUTHORITY", source: "rugcheck" });
      if (report.mintAuthority) allFlags.push({ flag: "MINT_AUTHORITY", source: "rugcheck" });
      for (const risk of report.risks ?? []) {
        const n = risk.name.toLowerCase();
        if (n.includes("honeypot") || n.includes("rugged"))
          allFlags.push({ flag: "HONEYPOT", source: "rugcheck" });
        if (n.includes("blacklist")) allFlags.push({ flag: "BLACKLIST", source: "rugcheck" });
        if (risk.level === "danger" && n.includes("tax"))
          allFlags.push({ flag: "HIGH_TAX", source: "rugcheck" });
      }
    } else {
      allFlags.push({ flag: "UNVERIFIED_CONTRACT", source: "rugcheck" });
      ok = false;
    }

    allFlags.push(...goplusSolFlags);

    const { score, flags } = computeScore(allFlags, onStrict);
    return { flags, score, ok };
  }

  const { score, flags } = computeScore(allFlags);
  return { flags, score, ok };
}

// ─── Holder and age intelligence ──────────────────────────────────────────────
// EVM  → Etherscan: first tx timestamp for age, tokenholderlist for concentration.
// Solana → Solscan: tokenCreatedAt for age, holders endpoint for concentration.

type AgeAndHolders = {
  ageHours: number | null;
  top3Pct: number | null;
  holderCount: number | null;
  whaleAlert: boolean | null; // true if any single transfer >= 1% of supply in last 24h
  distributingWallets: number | null; // wallets with 6+ sells of >=0.1% supply in last 24h
};

async function checkAgeAndHolders(
  address: string,
  chainClass: "evm" | "solana",
  chainId: string,
): Promise<AgeAndHolders> {
  if (chainClass === "evm") return checkEtherscan(address, chainId);
  return checkSolscan(address);
}

// Etherscan V2 free tier only covers Ethereum mainnet (chainid=1).
// Other chains (BSC=56, Base=8453, etc.) require a paid plan — skip them rather than wasting a call.
const ETHERSCAN_FREE_CHAINS = new Set(["ethereum"]);

async function checkEtherscan(
  address: string,
  chainId: string,
  _ageOnly = false,
): Promise<AgeAndHolders> {
  const key = process.env["ETHERSCAN_API_KEY"] ?? "";
  if (!key || !ETHERSCAN_FREE_CHAINS.has(chainId))
    return {
      ageHours: null,
      top3Pct: null,
      holderCount: null,
      whaleAlert: null,
      distributingWallets: null,
    };

  const base = "https://api.etherscan.io/v2/api?chainid=1";
  const cutoff24h = Math.floor(Date.now() / 1000) - 86_400;

  try {
    // Full scan only — all fetches go through the rate limiter queue (≤2/sec globally).
    // ageOnly path removed: polling now derives age from DexScreener pairCreatedAt instead.
    const [ageResp, supplyResp] = await Promise.all([
      etherscanFetch(
        `${base}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
      etherscanFetch(
        `${base}&module=stats&action=tokensupply&contractaddress=${address}&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
    ]);
    const [holdersResp, transfersResp] = await Promise.all([
      etherscanFetch(
        `${base}&module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
      etherscanFetch(
        `${base}&module=account&action=tokentx&contractaddress=${address}&page=1&offset=50&sort=desc&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
    ]);

    let ageHours: number | null = null;
    if (ageResp.ok) {
      const body = (await ageResp.json()) as { result?: Array<{ timeStamp?: string }> };
      const ts = parseInt(body.result?.[0]?.timeStamp ?? "0", 10);
      if (ts > 0) ageHours = (Date.now() / 1000 - ts) / 3600;
    }

    let top3Pct: number | null = null;
    let holderCount: number | null = null;
    let totalSupply = 0;

    // tokensupply is free tier — parse it independently so whale detection works
    // even when tokenholderlist fails (that endpoint requires Etherscan Pro).
    // Etherscan always returns HTTP 200; check status field for actual success.
    if (supplyResp.ok) {
      const supplyBody = (await supplyResp.json()) as { status?: string; result?: string };
      if (supplyBody.status === "1") {
        totalSupply = parseFloat(supplyBody.result ?? "0");
      } else {
        console.warn(`[research] Etherscan tokensupply: ${supplyBody.result ?? "unknown error"}`);
      }
    }

    if (holdersResp.ok && totalSupply > 0) {
      const holdersBody = (await holdersResp.json()) as {
        status?: string;
        result?: Array<{ TokenHolderQuantity?: string }>;
      };
      if (holdersBody.status === "1") {
        const holders = holdersBody.result ?? [];
        holderCount = holders.length;
        if (holders.length >= 3) {
          const top3 = holders
            .slice(0, 3)
            .reduce((sum, h) => sum + parseFloat(h.TokenHolderQuantity ?? "0"), 0);
          top3Pct = (top3 / totalSupply) * 100;
        }
      }
    }

    let whaleAlert: boolean | null = null;
    let distributingWallets: number | null = null;

    if (transfersResp.ok && totalSupply > 0) {
      const txBody = (await transfersResp.json()) as {
        status?: string;
        result?: Array<{ from?: string; value?: string; timeStamp?: string }>;
      };
      if (txBody.status !== "1") {
        console.warn(
          `[research] Etherscan tokentx: ${typeof txBody.result === "string" ? txBody.result : "unknown error"}`,
        );
      } else {
        // Filter to last 24h — tokentx includes swaps (DEX sells appear as Transfer from user to pool).
        const txns = (txBody.result ?? []).filter(
          (tx) => parseInt(tx.timeStamp ?? "0", 10) >= cutoff24h,
        );

        whaleAlert = txns.some((tx) => parseFloat(tx.value ?? "0") / totalSupply >= 0.01);

        // Distribution detection: group by sender, count transfers >= 0.1% supply.
        // 6+ such moves from the same wallet in 24h signals coordinated distribution / slow rug.
        const sellsByWallet = new Map<string, number>();
        for (const tx of txns) {
          const from = (tx.from ?? "").toLowerCase();
          if (!from || from === address.toLowerCase()) continue; // skip mint events
          if (parseFloat(tx.value ?? "0") / totalSupply >= 0.001)
            sellsByWallet.set(from, (sellsByWallet.get(from) ?? 0) + 1);
        }
        distributingWallets = [...sellsByWallet.values()].filter((n) => n >= 6).length;

        if (whaleAlert) console.log(`[research] ${address.slice(0, 10)}: whale alert`);
        else if (distributingWallets)
          console.log(
            `[research] ${address.slice(0, 10)}: ${distributingWallets} distributing wallet(s)`,
          );
      }
    }

    return { ageHours, top3Pct, holderCount, whaleAlert, distributingWallets };
  } catch {
    return {
      ageHours: null,
      top3Pct: null,
      holderCount: null,
      whaleAlert: null,
      distributingWallets: null,
    };
  }
}

// Solana whale/holder detection skipped — Solscan Pro API requires a paid plan.
// Helius can replace this post-hackathon: GET /v0/addresses/{mint}/transactions?type=TRANSFER
function checkSolscan(_address: string): Promise<AgeAndHolders> {
  return Promise.resolve({
    ageHours: null,
    top3Pct: null,
    holderCount: null,
    whaleAlert: null,
    distributingWallets: null,
  });
}

// ─── GeckoTerminal OHLCV ─────────────────────────────────────────────────────
// Free, no auth required. Owned by CoinGecko but DEX-pool-first — data is real-time
// (same feed as DexScreener). Gives proper candlestick history instead of stale % changes.
//
// Two-step: (1) find best pool for the token, (2) fetch 48 hourly + 14 daily candles.
// Derived metrics: price trend, volume trend, volatility, ATH/ATL, price-vs-range.

const GECKO_NETWORK: Record<string, string> = {
  ethereum: "eth",
  bsc: "bsc",
  polygon: "polygon_pos",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism_ethereum",
  avalanche: "avax",
  solana: "solana",
  blast: "blast",
  scroll: "scroll",
  mantle: "mantle",
  linea: "linea",
  zksync: "zksync",
  unichain: "unichain",
  berachain: "berachain",
};

type GeckoTerminalData = {
  priceTrend: "rising" | "falling" | "sideways";
  volumeTrend: "accelerating" | "decelerating" | "stable";
  volatility14d: number; // avg (daily_high - daily_low) / close over 14 days
  ath48h: number | null; // highest wick in last 48 hourly candles
  atl48h: number | null; // lowest wick in last 48 hourly candles
  ath14d: number | null;
  atl14d: number | null;
  priceVsRange14d: number | null; // 0.0 = near 14d low, 1.0 = near 14d high
  consecutiveGreen: number; // consecutive green daily candles from most recent
  consecutiveRed: number;
};

// OHLCV candle tuple: [timestamp, open, high, low, close, volume]
type OhlcvCandle = [number, number, number, number, number, number];

async function fetchGeckoTerminal(
  address: string,
  chainId: string,
): Promise<GeckoTerminalData | null> {
  const network = GECKO_NETWORK[chainId];
  if (!network) return null;

  // Step 1: find best pool (highest reserve) for the token.
  const poolsResp = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  ).catch(() => null);
  if (!poolsResp?.ok) return null;

  const poolsBody = (await poolsResp.json()) as {
    data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }>;
  };
  const bestPool = (poolsBody.data ?? []).sort(
    (a, b) =>
      parseFloat(b.attributes?.reserve_in_usd ?? "0") -
      parseFloat(a.attributes?.reserve_in_usd ?? "0"),
  )[0];
  const poolAddress = bestPool?.attributes?.address;
  if (!poolAddress) return null;

  // Step 2: 48 hourly + 14 daily candles in parallel.
  const ohlcvBase = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv`;
  const [hourlyResp, dailyResp] = await Promise.all([
    fetch(`${ohlcvBase}/hour?limit=48&currency=usd`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null),
    fetch(`${ohlcvBase}/day?limit=14&currency=usd`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null),
  ]);

  type OhlcvBody = { data?: { attributes?: { ohlcv_list?: OhlcvCandle[] } } };

  // GeckoTerminal returns newest-first; reverse so index 0 = oldest.
  let hourly: OhlcvCandle[] = [];
  let daily: OhlcvCandle[] = [];
  if (hourlyResp?.ok) {
    const b = (await hourlyResp.json()) as OhlcvBody;
    hourly = [...(b.data?.attributes?.ohlcv_list ?? [])].reverse();
  }
  if (dailyResp?.ok) {
    const b = (await dailyResp.json()) as OhlcvBody;
    daily = [...(b.data?.attributes?.ohlcv_list ?? [])].reverse();
  }
  if (hourly.length === 0 && daily.length === 0) return null;

  // ─ Price trend: avg close of most recent 12h vs prior 12h ──────────────────
  let priceTrend: "rising" | "falling" | "sideways" = "sideways";
  if (hourly.length >= 24) {
    const avg = (arr: OhlcvCandle[]) => arr.reduce((s, c) => s + c[4], 0) / arr.length;
    const ratio = avg(hourly.slice(-12)) / avg(hourly.slice(-24, -12));
    if (ratio > 1.02) priceTrend = "rising";
    else if (ratio < 0.98) priceTrend = "falling";
  }

  // ─ ATH / ATL (48h hourly window) ──────────────────────────────────────────
  const ath48h = hourly.length > 0 ? Math.max(...hourly.map((c) => c[2])) : null;
  const atl48h = hourly.length > 0 ? Math.min(...hourly.map((c) => c[3])) : null;

  // ─ Volume trend: avg last 3 days vs prior 3 days ──────────────────────────
  let volumeTrend: "accelerating" | "decelerating" | "stable" = "stable";
  if (daily.length >= 6) {
    const avgVol = (arr: OhlcvCandle[]) => arr.reduce((s, c) => s + c[5], 0) / arr.length;
    const ratio = avgVol(daily.slice(-3)) / avgVol(daily.slice(-6, -3));
    if (ratio > 1.2) volumeTrend = "accelerating";
    else if (ratio < 0.8) volumeTrend = "decelerating";
  }

  // ─ ATH / ATL + volatility (14d daily window) ──────────────────────────────
  const ath14d = daily.length > 0 ? Math.max(...daily.map((c) => c[2])) : null;
  const atl14d = daily.length > 0 ? Math.min(...daily.map((c) => c[3])) : null;
  const volatility14d =
    daily.length > 0
      ? daily.reduce((s, c) => s + (c[4] > 0 ? (c[2] - c[3]) / c[4] : 0), 0) / daily.length
      : 0;

  // ─ Price vs 14d range (0 = near bottom, 1 = near top) ────────────────────
  let priceVsRange14d: number | null = null;
  if (ath14d !== null && atl14d !== null && ath14d > atl14d && hourly.length > 0) {
    const currentClose = hourly[hourly.length - 1]![4];
    priceVsRange14d = (currentClose - atl14d) / (ath14d - atl14d);
  }

  // ─ Consecutive green / red daily candles (from most recent) ──────────────
  let consecutiveGreen = 0;
  let consecutiveRed = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    const c = daily[i]!;
    const isGreen = c[4] >= c[1]; // close >= open
    if (consecutiveGreen === 0 && consecutiveRed === 0) {
      if (isGreen) consecutiveGreen = 1;
      else consecutiveRed = 1;
    } else if (consecutiveGreen > 0 && isGreen) {
      consecutiveGreen++;
    } else if (consecutiveRed > 0 && !isGreen) {
      consecutiveRed++;
    } else break;
  }

  return {
    priceTrend,
    volumeTrend,
    volatility14d,
    ath48h,
    atl48h,
    ath14d,
    atl14d,
    priceVsRange14d,
    consecutiveGreen,
    consecutiveRed,
  };
}

// ─── GDELT rate-limit gate ────────────────────────────────────────────────────
// GDELT 429s under parallel processCandidate() load. One slot per polling cycle.
let gdeltLastCallAt = 0;
const GDELT_COOLDOWN_MS = 30_000;

// ─── Fear & Greed Index (cached 15 min) ──────────────────────────────────────
let fearGreedCache: { value: number; expiresAt: number } | null = null;

async function getFearGreedIndex(): Promise<number> {
  if (fearGreedCache && Date.now() < fearGreedCache.expiresAt) return fearGreedCache.value;
  try {
    const resp = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const body = (await resp.json()) as { data?: Array<{ value?: string }> };
      const value = parseInt(body.data?.[0]?.value ?? "50", 10);
      fearGreedCache = { value, expiresAt: Date.now() + 15 * 60 * 1_000 };
      return value;
    }
  } catch {
    /* fall through */
  }
  return 50;
}

// ─── Trend signal source checks ────────────────────────────────────────────────

async function checkGdelt(terms: string[]): Promise<boolean> {
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
          return false;
        }
        const body = (await resp.json()) as { articles?: unknown[] };
        const count = body.articles?.length ?? 0;
        return count > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.some((r) => r.status === "fulfilled" && r.value);
}

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

async function checkStocktwits(terms: string[]): Promise<boolean> {
  const results = await Promise.allSettled(
    terms.map(async (term) => {
      try {
        const resp = await fetch(
          `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(term)}.json`,
          { signal: AbortSignal.timeout(6_000) },
        );
        if (!resp.ok) return false;
        const body = (await resp.json()) as { messages?: unknown[] };
        return (body.messages?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.some((r) => r.status === "fulfilled" && r.value);
}

// ─── Reddit multi-subreddit signal ────────────────────────────────────────────
// 23 subreddits in one logical pass: 11 crypto-native + 12 news/world.
// News subs catch real-world narratives driving token demand (World Cup, elections, etc.)
// Each subreddit with a qualifying post adds one signal point independently.
const REDDIT_CRYPTO_SUBS = [
  "CryptoCurrency",
  "CryptoMoonShots",
  "DeFi",
  "SatoshiStreetBets",
  "CryptoMarkets",
  "memecoin",
  "solana",
  "ethereum",
  "BSCMoonShots",
  "CryptoNews",
  "altcoin",
] as const;

const REDDIT_NEWS_SUBS = [
  "worldnews",
  "news",
  "geopolitics",
  "investing",
  "finance",
  "Economics",
  "sports",
  "soccer",
  "technology",
  "Futurology",
  "entertainment",
  "politics",
] as const;

async function checkReddit(ticker: string, tokenName: string): Promise<string[]> {
  const seenPostIds = new Set<string>();
  const matchedSubs = new Set<string>();
  const nowSec = Date.now() / 1000;
  const cutoff48h = nowSec - 48 * 3600;

  async function processUrl(url: string, minUps: number, _label: string): Promise<void> {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "hawkeye-research-agent/0.1" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        return;
      }
      const body = (await resp.json()) as {
        data?: {
          children?: Array<{
            data: {
              name: string;
              subreddit: string;
              ups: number;
              created_utc: number;
              title: string;
            };
          }>;
        };
      };
      for (const child of body.data?.children ?? []) {
        const post = child.data;
        if (seenPostIds.has(post.name)) continue;
        seenPostIds.add(post.name);
        if (post.created_utc > cutoff48h && post.ups >= minUps) {
          matchedSubs.add(post.subreddit);
        }
      }
    } catch {
      /* fail open */
    }
  }

  const cryptoPath = REDDIT_CRYPTO_SUBS.join("+");
  const newsPath = REDDIT_NEWS_SUBS.join("+");
  const requests: Promise<void>[] = [];

  // Short tickers (≤4 chars) are common words — only search dollar-prefix to avoid
  // "BULL" matching every "bullish" or "bull run" post.
  const cryptoQueries = ticker.length <= 4 ? [`$${ticker}`] : [ticker, `$${ticker}`];
  for (const q of cryptoQueries) {
    requests.push(
      processUrl(
        `https://www.reddit.com/r/${cryptoPath}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=25`,
        3,
        q,
      ),
    );
  }

  // News subs — title-only quoted token name, higher upvote bar.
  // Guard: name ≥5 chars and name ≠ ticker (no redundant search).
  const namePhrase = tokenName.trim();
  if (namePhrase.length >= 5 && namePhrase.toLowerCase() !== ticker.toLowerCase()) {
    requests.push(
      processUrl(
        `https://www.reddit.com/r/${newsPath}/search.json?q=${encodeURIComponent(`title:"${namePhrase}"`)}&restrict_sr=1&sort=new&limit=25`,
        10,
        `title:"${namePhrase}"`,
      ),
    );
  }

  await Promise.allSettled(requests);
  return [...matchedSubs];
}

// Tavily — deep search. Polling loop uses days=3 (fresh signal only).
// RESEARCH_REQUEST uses days=7 (more historical context).
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
    const body = (await resp.json()) as { results?: unknown[] };
    return (body.results?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ─── Trend signal aggregator ───────────────────────────────────────────────────
type TrendSignal = {
  mentionCount: number;
  sources: string[];
  fearGreed: number;
};

function expandSearchTerms(ticker: string, tokenName: string): string[] {
  const terms = new Set<string>([ticker]);
  const stripped = ticker.replace(/^\d+|\d+$/, "").trim();
  if (stripped.length >= 3 && stripped !== ticker) terms.add(stripped);
  for (const word of tokenName.split(/\s+/)) {
    if (word.length >= 4) terms.add(word);
  }
  return [...terms];
}

// withGdelt=false for polling loop (429s under parallel load).
// withGdelt=true for RESEARCH_REQUEST (user-triggered, rare, worth the call).
async function checkTrendSignal(
  ticker: string,
  tokenName: string,
  withGdelt = false,
): Promise<TrendSignal> {
  const terms = expandSearchTerms(ticker, tokenName);
  const rssTerms = [...new Set([...terms, tokenName])]
    .filter((t) => t.length >= 2)
    .map((t) => (t.length <= 4 ? `$${t}` : t));

  const [gdelt, rss, stocktwits, reddit, fearGreed] = await Promise.allSettled([
    withGdelt ? checkGdelt(terms) : Promise.resolve(false),
    checkRssFeeds(rssTerms),
    checkStocktwits(terms),
    checkReddit(ticker, tokenName),
    getFearGreedIndex(),
  ]);

  const sources: string[] = [];
  if (gdelt.status === "fulfilled" && gdelt.value) sources.push("gdelt");
  if (rss.status === "fulfilled" && rss.value) sources.push("rss");
  if (stocktwits.status === "fulfilled" && stocktwits.value) sources.push("stocktwits");
  if (reddit.status === "fulfilled") {
    for (const sub of reddit.value) sources.push(`reddit/${sub}`);
  }

  const fg = fearGreed.status === "fulfilled" ? fearGreed.value : 50;
  return { mentionCount: sources.length, sources, fearGreed: fg };
}

// ─── Narrative multiplier ──────────────────────────────────────────────────────
function computeNarrativeMultiplier(signal: TrendSignal): number {
  let base: number;
  if (signal.mentionCount >= 3) base = 1.7;
  else if (signal.mentionCount === 2) base = 1.4;
  else if (signal.mentionCount === 1) base = 1.15;
  else base = 1.0;

  let fgAdjust = 0;
  if (signal.fearGreed >= 75) fgAdjust = 0.1;
  else if (signal.fearGreed <= 25) fgAdjust = -0.1;

  return Math.min(1.8, Math.max(1.0, base + fgAdjust));
}

// ─── Polling cycle ─────────────────────────────────────────────────────────────
async function runPollingCycle(): Promise<void> {
  try {
    const [profiles, boosts, arkhamTrending] = await Promise.allSettled([
      getLatestTokenProfiles(),
      getLatestBoosts(),
      _pollingArkham ? _pollingArkham.getTrending() : Promise.resolve([]),
    ]);

    const candidates = new Map<string, { address: string; chainId: DexScreenerChain }>();
    const dexItems = [
      ...(profiles.status === "fulfilled" ? profiles.value : []),
      ...(boosts.status === "fulfilled" ? boosts.value : []),
    ];
    for (const item of dexItems) {
      if (!isValidChain(item.chainId)) continue;
      const key = `${item.chainId}:${item.tokenAddress.toLowerCase()}`;
      const seenAt = seenTokens.get(key);
      if (!seenAt || Date.now() - seenAt > SEEN_TOKEN_TTL_MS) {
        candidates.set(key, {
          address: item.tokenAddress,
          chainId: item.chainId as DexScreenerChain,
        });
      }
    }
    // Arkham trending tokens — map to candidate shape, ethereum chain default
    if (arkhamTrending.status === "fulfilled") {
      for (const t of arkhamTrending.value) {
        const address = t.pricingID;
        if (!address || !address.startsWith("0x")) continue;
        const key = `ethereum:${address.toLowerCase()}`;
        const seenAt = seenTokens.get(key);
        if (!seenAt || Date.now() - seenAt > SEEN_TOKEN_TTL_MS) {
          candidates.set(key, { address, chainId: "ethereum" as DexScreenerChain });
        }
      }
    }

    if (candidates.size > 20) {
      console.log(`[research] scanning ${candidates.size} candidates...`);
    }

    for (const [key, candidate] of candidates) {
      seenTokens.set(key, Date.now());
      void processCandidate(candidate.address, candidate.chainId);
    }
  } catch (err) {
    console.error("[research] polling cycle error:", err);
  }
}

// ─── Candidate pipeline ────────────────────────────────────────────────────────
async function processCandidate(address: string, chainId: DexScreenerChain): Promise<void> {
  try {
    // Stage 1: liquidity + volume filter
    const pairs = await getPairsByToken(chainId, address).catch(() => [] as DexPair[]);
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return;

    const liquidityUsd = best.liquidity?.usd ?? 0;
    const volume24h = best.volume?.h24 ?? 0;
    const ticker = best.baseToken.symbol;
    const tokenName = best.baseToken.name;
    const priceUsd = parseFloat(best.priceUsd ?? "0") || 0;

    const volLiqRatio = liquidityUsd > 0 ? volume24h / liquidityUsd : 0;
    if (
      liquidityUsd < MIN_LIQUIDITY_USD ||
      volume24h < MIN_VOLUME_24H ||
      volLiqRatio < MIN_VOL_LIQ_RATIO
    )
      return;

    // verbose candidate log removed — only log tokens that pass all filters

    // Stage 2: security scan
    const chainClass = detectChainClass(address);
    const security = await runSecurityScan(address, chainClass, chainId);

    if (security.flags.includes("HONEYPOT")) return;
    if (security.flags.includes("KNOWN_RUGGER")) return;

    const safetyScore = security.score;

    // Stage 3: age gate via DexScreener pairCreatedAt — zero extra API calls from polling.
    // Etherscan is never touched here; the rate limiter queue is reserved for research requests.
    const pairCreatedAt = best.pairCreatedAt;
    const pairAgeHours = pairCreatedAt ? (Date.now() - pairCreatedAt) / 3_600_000 : null;
    if (pairAgeHours !== null && pairAgeHours < 1) return;

    const adjustedSafetyScore = safetyScore;

    // Stage 5: trend signal + narrative multiplier + ALPHA_FOUND
    let trend: TrendSignal = { mentionCount: 0, sources: [], fearGreed: 50 };
    if (!INDUSTRY_TERM_TICKERS.has(ticker.toUpperCase())) {
      trend = await checkTrendSignal(ticker, tokenName);
      if (trend.mentionCount === 1) {
        const tavilyConfirmed = await checkTavily(ticker);
        if (tavilyConfirmed) trend.sources.push("tavily");
        trend.mentionCount = trend.sources.length;
      }
    }

    const multiplier = computeNarrativeMultiplier(trend);
    const opportunityScore = Math.min(100, Math.round(adjustedSafetyScore * multiplier));

    if (opportunityScore < ALPHA_THRESHOLD) return;

    // Require at least one trend signal — unless fundamentals are strong enough to stand alone.
    // holderCount not available in polling (no Etherscan); liquidity + volume gate is sufficient.
    const fundamentalsOverride = liquidityUsd > 100_000 && volume24h > 200_000;

    if (trend.sources.length === 0 && !fundamentalsOverride) return;

    console.log(
      `[research] ALPHA: ${ticker} (${chainId}) score=${opportunityScore}` +
        ` safety=${safetyScore} liq=$${(liquidityUsd / 1000).toFixed(0)}k trend=[${trend.sources.join(",")}]`,
    );

    const whaleWarn = "";
    const distWarn = "";

    const reason =
      `${ticker} scored ${opportunityScore}/100 ` +
      `(safety ${safetyScore}, ${multiplier.toFixed(2)}x narrative boost). ` +
      (trend.sources.length > 0
        ? `Trend confirmed by: ${trend.sources.join(", ")}.`
        : "Passes all safety filters — no active trend signals.") +
      whaleWarn +
      distWarn;

    void priceUsd;

    bus.emit("ALPHA_FOUND", {
      address,
      chainId: chainId as ChainId,
      safetyScore: adjustedSafetyScore,
      liquidityUsd,
      reason,
      foundAt: Date.now(),
    } satisfies AlphaFoundPayload);
  } catch (err) {
    console.error(`[research] error processing ${address} (${chainId}):`, err);
  }
}

// ─── CoinGecko ────────────────────────────────────────────────────────────────
type CoinGeckoData = {
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  sentimentUp: number | null;
  sentimentDown: number | null;
};

async function fetchCoinGecko(ticker: string): Promise<CoinGeckoData | null> {
  const empty: CoinGeckoData = {
    priceUsd: null,
    marketCap: null,
    volume24h: null,
    sentimentUp: null,
    sentimentDown: null,
  };
  try {
    const searchResp = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!searchResp.ok) return empty;
    const searchBody = (await searchResp.json()) as {
      coins?: Array<{ id: string; symbol: string }>;
    };
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
    const coin = (await coinResp.json()) as {
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
      };
      sentiment_votes_up_percentage?: number;
      sentiment_votes_down_percentage?: number;
    };
    return {
      priceUsd: coin.market_data?.current_price?.usd ?? null,
      marketCap: coin.market_data?.market_cap?.usd ?? null,
      volume24h: coin.market_data?.total_volume?.usd ?? null,
      sentimentUp: coin.sentiment_votes_up_percentage ?? null,
      sentimentDown: coin.sentiment_votes_down_percentage ?? null,
    };
  } catch {
    return empty;
  }
}

// ─── Birdeye (Solana only) ────────────────────────────────────────────────────
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
    const body = (await resp.json()) as { data?: { price?: number; v24hUSD?: number } };
    return { priceUsd: body.data?.price ?? null, volume24h: body.data?.v24hUSD ?? null };
  } catch {
    return null;
  }
}

// ─── Brave Search ─────────────────────────────────────────────────────────────
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
    const body = (await resp.json()) as {
      web?: { results?: Array<{ title?: string; description?: string; url?: string }> };
    };
    return (body.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      description: r.description ?? "",
      url: r.url ?? "",
    }));
  } catch {
    return [];
  }
}

type DefiLlamaData = {
  tvl: number | null;
  tvlChange1d: number | null;
  mcapTvlRatio: number | null;
  category: string | null;
  chains: string[];
};

async function _fetchDefiLlama(tokenName: string, ticker: string): Promise<DefiLlamaData | null> {
  const empty: DefiLlamaData = {
    tvl: null,
    tvlChange1d: null,
    mcapTvlRatio: null,
    category: null,
    chains: [],
  };
  try {
    const resp = await fetch("https://api.llama.fi/protocols", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return empty;
    const protocols = (await resp.json()) as Array<{
      name: string;
      symbol: string;
      tvl: number;
      change_1d: number | null;
      mcap: number | null;
      category: string;
      chains: string[];
    }>;
    const lower = ticker.toLowerCase();
    const nameLower = tokenName.toLowerCase();
    const match = protocols.find(
      (p) => p.symbol?.toLowerCase() === lower || p.name?.toLowerCase() === nameLower,
    );
    if (!match) return empty;
    const ratio = match.mcap && match.tvl > 0 ? match.mcap / match.tvl : null;
    return {
      tvl: match.tvl,
      tvlChange1d: match.change_1d,
      mcapTvlRatio: ratio,
      category: match.category,
      chains: match.chains ?? [],
    };
  } catch {
    return empty;
  }
}

type DefiLlamaTrending = {
  name: string;
  symbol: string;
  tvl: number;
  change1d: number | null;
  category: string;
  chains: string[];
};

async function fetchDefiLlamaTrending(chain?: string, limit = 10): Promise<DefiLlamaTrending[]> {
  try {
    const resp = await fetch("https://api.llama.fi/protocols", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const protocols = (await resp.json()) as Array<{
      name: string;
      symbol: string;
      tvl: number;
      change_1d: number | null;
      category: string;
      chains: string[];
    }>;

    let filtered = protocols.filter(
      (p) => p.tvl > 100_000 && p.category !== "CEX" && p.category !== "Exchange",
    );
    if (chain) {
      const cl = chain.toLowerCase();
      filtered = filtered.filter((p) => p.chains?.some((c) => c.toLowerCase() === cl));
    }
    filtered.sort((a, b) => (b.change_1d ?? 0) - (a.change_1d ?? 0));
    return filtered.slice(0, limit).map((p) => ({
      name: p.name,
      symbol: p.symbol ?? "",
      tvl: p.tvl,
      change1d: p.change_1d,
      category: p.category,
      chains: p.chains ?? [],
    }));
  } catch {
    return [];
  }
}

type DuneSmartMoneyFlow = {
  token: string;
  netFlow: number;
  txCount: number;
};

async function fetchDuneSmartMoney(chain?: string): Promise<DuneSmartMoneyFlow[]> {
  const key = process.env["DUNE_API_KEY"];
  if (!key) return [];
  // Public Dune query for smart money token flows (community query)
  // Query 3521429 = "Smart Money Token Inflows Last 24h"
  const queryId = chain === "solana" ? "3521430" : "3521429";
  try {
    const resp = await fetch(`https://api.dune.com/api/v1/query/${queryId}/results?limit=10`, {
      headers: { "X-Dune-Api-Key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as {
      result?: {
        rows?: Array<{ token_symbol?: string; net_flow_usd?: number; tx_count?: number }>;
      };
    };
    return (body.result?.rows ?? []).map((r) => ({
      token: r.token_symbol ?? "?",
      netFlow: r.net_flow_usd ?? 0,
      txCount: r.tx_count ?? 0,
    }));
  } catch {
    return [];
  }
}

// ─── LLM synthesis ────────────────────────────────────────────────────────────
// Prefers the injected LlmClient (Israel's FallbackLlmClient at startup).
// Falls back to direct OgComputeClient if no client is injected (standalone/smoke-test).
// Returns "" on failure — caller uses buildTemplateSummary() as the final fallback.
let _ogClient: OgComputeClient | null = null;

function getOgClient(): OgComputeClient {
  if (!_ogClient) _ogClient = new OgComputeClient();
  return _ogClient;
}

async function callLLM(prompt: string, llm?: LlmClient): Promise<string> {
  if (llm) {
    try {
      const resp = await llm.infer({
        system: "You are a crypto research assistant. Give concise, direct verdicts on tokens.",
        user: prompt,
        maxTokens: 250,
      });
      const result = resp.text.trim();
      if (result) return result;
      console.warn("[research] injected LLM returned empty — falling back to OgComputeClient");
    } catch (err) {
      console.error("[research] injected LLM failed:", err);
    }
  }

  // Standalone fallback: direct OgComputeClient.
  if (!process.env["HAWKEYE_EVM_PRIVATE_KEY"]) return "";
  try {
    const resp = await getOgClient().infer({
      system: "You are a crypto research assistant. Give concise, direct verdicts on tokens.",
      user: prompt,
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
type NansenFlows = NansenFlowsImported;
type ResearchData = {
  ticker: string;
  tokenName: string;
  address: string;
  chainId: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  security: { flags: SafetyFlag[]; score: number; ok: boolean };
  age: AgeAndHolders;
  trend: TrendSignal;
  cg: CoinGeckoData | null;
  birdeye: BirdeyeData | null;
  brave: BraveResult[];
  gecko: GeckoTerminalData | null;
  priceChange: { h1: number | null; h6: number | null; h24: number | null } | null;
  arkhamHolders: ArkhamHolder[];
  arkhamFlows: ArkhamFlow[];
  nansenFlows: NansenFlows | null;
  duneFlows: DuneSmartMoneyFlow[];
  opportunityScore: number;
  question: string;
  subIntent: ResearchSubIntent;
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

  // DexScreener short-term price changes (real-time)
  if (d.priceChange) {
    const parts: string[] = [];
    if (d.priceChange.h1 != null) parts.push(`1h: ${d.priceChange.h1.toFixed(1)}%`);
    if (d.priceChange.h6 != null) parts.push(`6h: ${d.priceChange.h6.toFixed(1)}%`);
    if (d.priceChange.h24 != null) parts.push(`24h: ${d.priceChange.h24.toFixed(1)}%`);
    if (parts.length) lines.push(`Price change: ${parts.join(", ")}`);
  }

  // GeckoTerminal OHLCV — real-time candle data, not stale CoinGecko percentages
  if (d.gecko) {
    const g = d.gecko;
    lines.push(`Price trend (12h): ${g.priceTrend}`);
    lines.push(`Volume trend (3d vs prior 3d): ${g.volumeTrend}`);
    lines.push(`14d volatility: ${(g.volatility14d * 100).toFixed(1)}% avg daily range`);
    if (g.ath14d != null && g.atl14d != null)
      lines.push(`14d range: $${g.atl14d.toPrecision(4)} – $${g.ath14d.toPrecision(4)}`);
    if (g.priceVsRange14d != null)
      lines.push(
        `Price vs 14d range: ${(g.priceVsRange14d * 100).toFixed(0)}% (0=near low, 100=near high)`,
      );
    if (g.consecutiveGreen > 1) lines.push(`Consecutive green days: ${g.consecutiveGreen}`);
    if (g.consecutiveRed > 1) lines.push(`Consecutive red days: ${g.consecutiveRed}`);
  }

  // Transfer-based risk signals
  if (d.age.whaleAlert === true)
    lines.push("Whale alert: single transfer >= 1% of supply in last 24h");
  else if (d.age.whaleAlert === false)
    lines.push("Whale movement: clean (in the last 50 txns, no large moves detected)");
  if (d.age.distributingWallets !== null && d.age.distributingWallets > 0)
    lines.push(
      `Distribution alert: ${d.age.distributingWallets} wallet(s) with 6+ sells of >=0.1% supply in 24h`,
    );

  if (d.cg?.marketCap) lines.push(`Market cap: $${(d.cg.marketCap / 1e6).toFixed(1)}M`);
  if (d.cg?.sentimentUp) lines.push(`CoinGecko sentiment: ${d.cg.sentimentUp.toFixed(0)}% bullish`);
  if (d.birdeye?.volume24h) lines.push(`Birdeye 24h volume: $${d.birdeye.volume24h.toFixed(0)}`);
  if (d.brave.length > 0)
    lines.push(
      `Web results: ${d.brave
        .slice(0, 3)
        .map((r) => r.title)
        .join(" | ")}`,
    );

  if (d.arkhamHolders.length > 0) {
    lines.push(`\nTop holders (Arkham Intelligence):`);
    for (const h of d.arkhamHolders.slice(0, 5)) {
      const label = h.entity ?? h.address.slice(0, 10) + "...";
      lines.push(
        `  ${label}: ${h.percentage.toFixed(1)}% ($${formatCompact(h.usd).replace("$", "")})`,
      );
    }
    const top5Pct = d.arkhamHolders.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
    if (top5Pct > 40) lines.push(`  ⚠ Top-5 holders control ${top5Pct.toFixed(0)}% of supply`);
  }

  if (d.arkhamFlows.length > 0) {
    lines.push(`\nSmart money flows (24h, Arkham):`);
    for (const f of d.arkhamFlows.slice(0, 5)) {
      const label = f.entityName ?? f.address.slice(0, 10) + "...";
      const dir = f.netUSD >= 0 ? "net inflow" : "net outflow";
      lines.push(
        `  ${label} (${f.entityType ?? "unknown"}): ${dir} $${formatCompact(Math.abs(f.netUSD)).replace("$", "")}`,
      );
    }
    const totalNet = d.arkhamFlows.reduce((s, f) => s + f.netUSD, 0);
    lines.push(
      `  Net flow: ${totalNet >= 0 ? "+" : ""}$${formatCompact(Math.abs(totalNet)).replace("$", "")}`,
    );
  }

  if (d.nansenFlows) {
    lines.push(`\nNansen smart money flows:`);
    if (d.nansenFlows.smartMoney) {
      const net = d.nansenFlows.smartMoney.inflow - d.nansenFlows.smartMoney.outflow;
      lines.push(
        `  Smart Money: inflow $${formatCompact(d.nansenFlows.smartMoney.inflow)} / outflow $${formatCompact(d.nansenFlows.smartMoney.outflow)} (net ${net >= 0 ? "+" : ""}$${formatCompact(Math.abs(net))})`,
      );
    }
    if (d.nansenFlows.whales) {
      const net = d.nansenFlows.whales.inflow - d.nansenFlows.whales.outflow;
      lines.push(
        `  Whales: inflow $${formatCompact(d.nansenFlows.whales.inflow)} / outflow $${formatCompact(d.nansenFlows.whales.outflow)} (net ${net >= 0 ? "+" : ""}$${formatCompact(Math.abs(net))})`,
      );
    }
    if (d.nansenFlows.label) lines.push(`  Nansen label: ${d.nansenFlows.label}`);
  }
  if (d.duneFlows.length > 0) {
    const top = d.duneFlows.slice(0, 5);
    lines.push(`\nDune smart money flows (top tokens by net flow):`);
    for (const f of top) {
      const dir = f.netFlow >= 0 ? "inflow" : "outflow";
      lines.push(
        `  ${f.token}: net ${dir} $${formatCompact(Math.abs(f.netFlow))} (${f.txCount} txs)`,
      );
    }
  }

  const SUBINTENT_FOCUS: Record<ResearchSubIntent, string> = {
    TOKEN_LOOKUP:
      "Give a full breakdown: price, liquidity, safety score, holder concentration, smart money signals. 4-5 sentences. End with a bullish/bearish/neutral call.",
    WHALE_ANALYSIS:
      "Focus on who holds this token, smart money direction, and concentration risk. 3-4 sentences. Name specific entities if Arkham data is present.",
    TRENDING:
      "List the top tokens with their key stats. 1-2 lines per token. Include price, volume, and a one-word signal.",
    MARKET_OVERVIEW:
      "Cover BTC/ETH prices, 24h changes, fear & greed index, and top movers. 3-4 sentences.",
    CATEGORY:
      "List top tokens in this category sorted by 24h volume. 1-2 lines each with price and volume.",
    SAFETY_CHECK:
      "Lead with the safety score and each flag. Explain the specific risk each flag represents. 3-4 sentences. End with a clear safe/caution/avoid verdict.",
    PRICE_ACTION:
      "Cover recent price movement, volume trend, momentum direction, and support/resistance hints from candle data if available. 3-4 sentences. End with a momentum call.",
    RESEARCH_WALLET:
      "Identify the wallet entity/label if known, summarise recent token flows, and flag any notable activity. 3-4 sentences.",
  };

  lines.push(`\nUser question: ${d.question}`);
  lines.push(`\nFocus: ${SUBINTENT_FOCUS[d.subIntent]}`);
  lines.push(
    "\nONLY use numbers and facts from the data above. If a data source returned null or is missing, say 'data unavailable' for that field. NEVER invent statistics. Write like a crypto trader talking to a friend, not a formal report.",
  );
  return lines.join("\n");
}

function buildTemplateSummary(d: ResearchData): string {
  const parts: string[] = [];
  if (d.security.score >= 70 && d.security.flags.length === 0) {
    parts.push("Contract looks clean.");
  } else if (d.security.flags.length > 0) {
    parts.push(`Watch out: ${d.security.flags.join(", ").toLowerCase()}.`);
  }
  if (d.trend.sources.length > 0) {
    parts.push(`Getting attention on ${d.trend.sources.join(", ")}.`);
  }
  if (d.age.ageHours != null && d.age.ageHours < 48) {
    parts.push(`Very new token (${d.age.ageHours.toFixed(0)}h old).`);
  }
  if (d.age.whaleAlert === true) parts.push("Whale transfer detected.");
  if (d.age.distributingWallets) parts.push(`${d.age.distributingWallets} wallets distributing.`);
  if (d.gecko?.priceTrend) parts.push(`Price trend: ${d.gecko.priceTrend}.`);
  if (d.arkhamHolders.length > 0) {
    const top3Pct = d.arkhamHolders.slice(0, 3).reduce((s, h) => s + h.percentage, 0);
    if (top3Pct > 50) parts.push(`High concentration: top 3 holders own ${top3Pct.toFixed(0)}%.`);
  }
  if (d.arkhamFlows.length > 0) {
    const netFlow = d.arkhamFlows.reduce((s, f) => s + f.netUSD, 0);
    if (Math.abs(netFlow) > 10_000) {
      parts.push(`Smart money 24h: ${netFlow >= 0 ? "+" : ""}${formatCompact(netFlow)} net flow.`);
    }
  }
  if (d.opportunityScore >= 70) {
    parts.push("Looks promising, but always DYOR.");
  } else if (d.opportunityScore < 40) {
    parts.push("High risk. Proceed with caution.");
  }
  return (
    parts.join(" ") || "No notable signals found. Paste the contract address for a deeper look."
  );
}

// ─── RESEARCH_REQUEST handler ──────────────────────────────────────────────────
async function fetchCoinGeckoSearchTrending(): Promise<
  Array<{ id: string; name: string; symbol: string; market_cap_rank: number | null }>
> {
  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/search/trending", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      coins?: Array<{
        item: { id: string; name: string; symbol: string; market_cap_rank: number | null };
      }>;
    };
    return (data.coins ?? []).map((c) => c.item);
  } catch {
    return [];
  }
}

type TrendingCandidate = {
  symbol: string;
  name: string;
  address: string;
  chainId: string;
  priceUsd: string | null;
  liquidity: number;
  volume24h: number;
  priceChange24h: number | null;
  marketCap: number | null;
  source: "dexscreener" | "coingecko";
};

async function handleTrendingRequest(req: ResearchRequest, force = false): Promise<boolean> {
  const q = (req.question ?? req.rawText ?? "").toLowerCase();
  const isTrending =
    force || /\b(trending|trend|hot|alpha|movers?|new listing|pumping|top tokens?)\b/.test(q);
  if (!isTrending) return false;

  const filterChains = detectChainsFromText(req.rawText ?? "");
  const chainLabel = filterChains.length > 0 ? filterChains.join(" + ") : "all chains";
  log.agent(
    "research",
    `trending query: chains=[${filterChains.join(",") || "all"}] text="${q.slice(0, 60)}"`,
  );

  try {
    // Source 1: DexScreener profiles + boosts (real DEX activity)
    // Source 2: CoinGecko /search/trending (search buzz)
    const [profiles, boosts, cgTrending] = await Promise.all([
      getLatestTokenProfiles().catch(() => []),
      getLatestBoosts().catch(() => []),
      fetchCoinGeckoSearchTrending(),
    ]);

    const candidates: TrendingCandidate[] = [];
    const seenAddr = new Set<string>();

    // Process DexScreener profiles + boosts
    const dexTokens = [...profiles, ...boosts];
    for (const t of dexTokens) {
      const addr =
        (t as { tokenAddress?: string }).tokenAddress ?? (t as { address?: string }).address ?? "";
      const cid = (t as { chainId?: string }).chainId ?? "";
      if (!addr || !cid) continue;
      const key = `${cid}:${addr.toLowerCase()}`;
      if (seenAddr.has(key)) continue;

      if (filterChains.length > 0 && !filterChains.includes(cid)) continue;

      seenAddr.add(key);
      candidates.push({
        symbol: "",
        name: "",
        address: addr,
        chainId: cid,
        priceUsd: null,
        liquidity: 0,
        volume24h: 0,
        priceChange24h: null,
        marketCap: null,
        source: "dexscreener",
      });
    }

    // Process CoinGecko trending -- cross-ref with DexScreener for addresses
    const cgWithPairs = await Promise.all(
      cgTrending.slice(0, 10).map(async (coin) => {
        if (TRENDING_EXCLUDE_SYMBOLS.has(coin.symbol.toUpperCase())) return null;
        try {
          const { pairs } = await searchPairs(coin.symbol, { limit: 5 });
          const filtered = pairs
            .filter((p) => {
              const sym = p.baseToken?.symbol?.toUpperCase();
              if (sym !== coin.symbol.toUpperCase()) return false;
              if (filterChains.length > 0 && !filterChains.includes(p.chainId)) return false;
              return true;
            })
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
          return filtered[0] ?? null;
        } catch {
          return null;
        }
      }),
    );

    for (let i = 0; i < cgTrending.length && i < 10; i++) {
      const pair = cgWithPairs[i];
      if (!pair?.baseToken?.address) continue;
      const key = `${pair.chainId}:${pair.baseToken.address.toLowerCase()}`;
      if (seenAddr.has(key)) continue;
      seenAddr.add(key);
      candidates.push({
        symbol: pair.baseToken.symbol ?? cgTrending[i]!.symbol,
        name: pair.baseToken.name ?? cgTrending[i]!.name,
        address: pair.baseToken.address,
        chainId: pair.chainId,
        priceUsd: pair.priceUsd ?? null,
        liquidity: pair.liquidity?.usd ?? 0,
        volume24h: pair.volume?.h24 ?? 0,
        priceChange24h: pair.priceChange?.h24 ?? null,
        marketCap: pair.marketCap ?? null,
        source: "coingecko",
      });
    }

    // Enrich DexScreener candidates that lack pair data
    const needsEnrich = candidates.filter((c) => c.source === "dexscreener" && !c.symbol);
    if (needsEnrich.length > 0) {
      const enriched = await Promise.all(
        needsEnrich.slice(0, 12).map(async (c) => {
          try {
            const { pairs } = await searchPairs(c.address, { limit: 3 });
            const match = pairs
              .filter((p) => p.baseToken?.address?.toLowerCase() === c.address.toLowerCase())
              .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
            if (match?.baseToken) {
              c.symbol = match.baseToken.symbol ?? "";
              c.name = match.baseToken.name ?? "";
              c.priceUsd = match.priceUsd ?? null;
              c.liquidity = match.liquidity?.usd ?? 0;
              c.volume24h = match.volume?.h24 ?? 0;
              c.priceChange24h = match.priceChange?.h24 ?? null;
              c.marketCap = match.marketCap ?? null;
            }
          } catch {
            /* skip */
          }
        }),
      );
    }

    // Filter and sort
    const filtered = candidates
      .filter((c) => c.symbol && !TRENDING_EXCLUDE_SYMBOLS.has(c.symbol.toUpperCase()))
      .filter((c) => c.liquidity >= 1_000)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 8);

    if (filtered.length === 0) {
      bus.emit("RESEARCH_RESULT", {
        requestId: req.requestId,
        address: "trending",
        chain: req.chain ?? "evm",
        summary: `No trending tokens found on ${chainLabel}. Try again in a few minutes.`,
        safetyScore: null,
        priceUsd: null,
        liquidityUsd: null,
        flags: [],
        completedAt: Date.now(),
      });
      return true;
    }

    // Safety scan (parallel, 6s cap)
    const safetyMap = new Map<string, { score: number; flags: string[] }>();
    try {
      const scans = await Promise.all(
        filtered.map(async (d) => {
          const cc = d.chainId === "solana" ? ("solana" as const) : ("evm" as const);
          try {
            const result = await Promise.race([
              runSecurityScan(d.address, cc, d.chainId),
              new Promise<{ score: number; flags: string[]; ok: boolean }>((resolve) =>
                setTimeout(() => resolve({ score: -1, flags: [], ok: false }), 6_000),
              ),
            ]);
            return { address: d.address, ...result };
          } catch {
            return { address: d.address, score: -1, flags: [] as string[], ok: false };
          }
        }),
      );
      for (const s of scans) safetyMap.set(s.address, s);
    } catch {
      /* safety scan failed */
    }

    // Format output
    const lines: string[] = [];
    lines.push(`Trending on ${chainLabel}:\n`);
    let rank = 0;
    for (const d of filtered) {
      rank++;
      const sym = d.symbol.toUpperCase();
      const price = d.priceUsd ? `$${parseFloat(d.priceUsd).toPrecision(4)}` : "n/a";
      const vol = d.volume24h > 0 ? formatCompact(d.volume24h) : "";
      const liq = d.liquidity > 0 ? formatCompact(d.liquidity) : "";
      const h24 =
        d.priceChange24h != null
          ? `${d.priceChange24h > 0 ? "+" : ""}${d.priceChange24h.toFixed(1)}%`
          : "";
      const mc = d.marketCap ? formatCompact(d.marketCap) : "";

      const safety = safetyMap.get(d.address);
      let safetyLabel = "";
      if (safety && safety.score >= 0) {
        if (safety.flags.includes("HONEYPOT")) safetyLabel = " | HONEYPOT";
        else if (safety.score >= 70) safetyLabel = " | SAFE";
        else if (safety.score >= 40) safetyLabel = " | CAUTION";
        else safetyLabel = " | RISKY";
      }

      lines.push(`${rank}. ${sym} (${d.name})${safetyLabel}`);
      const details = [
        d.chainId,
        price,
        liq ? `liq ${liq}` : "",
        h24 ? `24h ${h24}` : "",
        vol ? `vol ${vol}` : "",
        mc ? `mc ${mc}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      lines.push(`   ${details}`);
      lines.push(`   ${d.address}`);
    }

    lines.push(`\nPaste any address above to research or trade.`);

    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: "trending",
      chain: req.chain ?? "evm",
      summary: lines.join("\n"),
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
      isTrending: true,
      subIntent: "TRENDING",
    });
  } catch (err) {
    log.error("trending query failed", err as Error);
    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: "trending",
      chain: req.chain ?? "evm",
      summary: "Trending scan failed. DexScreener may be rate-limited. Try again shortly.",
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
      subIntent: "TRENDING",
    });
  }
  return true;
}

async function handleMarketOverviewRequest(req: ResearchRequest, llm?: LlmClient): Promise<void> {
  log.agent("research", "market overview request");
  const [cgTop, fgS] = await Promise.allSettled([
    fetchCoinGeckoTrending("", 10),
    getFearGreedIndex(),
  ]);
  const topCoins = cgTop.status === "fulfilled" ? cgTop.value : [];
  const fg = fgS.status === "fulfilled" ? fgS.value : 50;

  const lines: string[] = [`Fear & Greed Index: ${fg}/100`];
  for (const coin of topCoins.slice(0, 5)) {
    const change =
      coin.price_change_percentage_24h != null
        ? ` (${coin.price_change_percentage_24h.toFixed(1)}% 24h)`
        : "";
    const price = coin.current_price != null ? ` $${coin.current_price.toLocaleString()}` : "";
    lines.push(`${coin.symbol?.toUpperCase() ?? coin.name}:${price}${change}`);
  }

  const contextStr = lines.join("\n");
  const prompt = `Market data:\n${contextStr}\n\nUser question: ${req.question}\n\nFocus: Cover BTC/ETH prices, 24h changes, fear & greed index, and top movers. 3-4 sentences.\n\nONLY use numbers and facts from the data above. Never invent statistics.`;
  let summary = await callLLM(prompt, llm);
  if (!summary) summary = `Fear & Greed: ${fg}/100. Market overview data:\n${lines.join("; ")}`;

  bus.emit("RESEARCH_RESULT", {
    requestId: req.requestId,
    address: "market",
    chain: "evm",
    summary,
    safetyScore: null,
    priceUsd: null,
    liquidityUsd: null,
    flags: [],
    completedAt: Date.now(),
    subIntent: "MARKET_OVERVIEW",
    fearGreed: fg,
  } satisfies ResearchResult);
}

async function handleWalletRequest(
  req: ResearchRequest,
  arkham?: ArkhamClient,
  llm?: LlmClient,
): Promise<boolean> {
  if (!req.address || !arkham) return false;
  log.agent("research", `wallet research: ${req.address.slice(0, 10)}...`);

  const [intelS, flowsS] = await Promise.allSettled([
    arkham.getAddressIntel(req.address),
    arkham.getTokenFlows("ethereum", req.address, "24h", 10),
  ]);
  const intel =
    intelS.status === "fulfilled" ? intelS.value : { entity: null, entityType: null, labels: [] };
  const flows = flowsS.status === "fulfilled" ? flowsS.value : [];

  const lines: string[] = [];
  if (intel.entity)
    lines.push(`Entity: ${intel.entity}${intel.entityType ? ` (${intel.entityType})` : ""}`);
  if (intel.labels.length > 0) lines.push(`Labels: ${intel.labels.join(", ")}`);
  if (flows.length > 0) {
    lines.push(`\nRecent 24h flows:`);
    for (const f of flows.slice(0, 5)) {
      const dir = f.netUSD >= 0 ? "net inflow" : "net outflow";
      lines.push(
        `  ${f.entityName ?? f.address.slice(0, 8)}: ${dir} $${formatCompact(Math.abs(f.netUSD))}`,
      );
    }
  }

  const contextStr = lines.join("\n") || "No Arkham data found for this address.";
  const prompt = `Wallet: ${req.address}\n${contextStr}\n\nQuestion: ${req.question ?? "Who is this wallet and what have they been doing?"}\n\nFocus: ${"Identify the wallet entity/label if known, summarise recent token flows, and flag any notable activity. 3-4 sentences."}\n\nONLY use numbers and facts from the provided data.`;

  let summary = await callLLM(prompt, llm);
  if (!summary) summary = contextStr || "No wallet data available.";

  bus.emit("RESEARCH_RESULT", {
    requestId: req.requestId,
    address: req.address,
    chain: req.chain ?? "evm",
    summary,
    safetyScore: null,
    priceUsd: null,
    liquidityUsd: null,
    flags: [],
    completedAt: Date.now(),
    subIntent: "RESEARCH_WALLET",
  } satisfies ResearchResult);
  return true;
}

// Chains where CoinGecko has a dedicated category (returns chain-specific results).
// All others fall back to DexScreener profiles/boosts for genuinely chain-local tokens.
const COINGECKO_SPECIFIC_CATEGORY_CHAINS = new Set(["base", "bsc", "solana"]);

async function handleCategoryRequest(req: ResearchRequest): Promise<boolean> {
  const chainHints = detectChainsFromText(req.rawText ?? "");
  const chain = chainHints[0] ?? "ethereum";
  log.agent("research", `category query: chain=${chain}`);

  const chainLabel = chain.charAt(0).toUpperCase() + chain.slice(1);

  // CoinGecko path: only for chains with a dedicated category
  if (COINGECKO_SPECIFIC_CATEGORY_CHAINS.has(chain)) {
    const coins = await fetchCoinGeckoTrending(chain, 10).catch(() => [] as CoinGeckoMarketItem[]);
    if (coins.length > 0) {
      const lines: string[] = [`Top memecoins on ${chainLabel} by volume:\n`];
      let rank = 0;
      for (const c of coins.slice(0, 10)) {
        rank++;
        const price = c.current_price != null ? `$${c.current_price.toPrecision(4)}` : "n/a";
        const vol =
          c.total_volume != null && c.total_volume > 0 ? formatCompact(c.total_volume) : "";
        const h24 =
          c.price_change_percentage_24h != null
            ? `${c.price_change_percentage_24h > 0 ? "+" : ""}${c.price_change_percentage_24h.toFixed(1)}%`
            : "";
        lines.push(
          `${rank}. ${c.symbol.toUpperCase()} — ${price}${h24 ? ` (${h24})` : ""}${vol ? ` | vol ${vol}` : ""}`,
        );
      }
      bus.emit("RESEARCH_RESULT", {
        requestId: req.requestId,
        address: "category",
        chain: req.chain ?? "evm",
        summary: lines.join("\n"),
        safetyScore: null,
        priceUsd: null,
        liquidityUsd: null,
        flags: [],
        completedAt: Date.now(),
        subIntent: "CATEGORY",
      } satisfies ResearchResult);
      return true;
    }
  }

  // DexScreener path: profiles + boosts filtered to the requested chain
  const [profilesS, boostsS] = await Promise.allSettled([
    getLatestTokenProfiles(),
    getLatestBoosts(),
  ]);
  const profiles = profilesS.status === "fulfilled" ? profilesS.value : [];
  const boosts = boostsS.status === "fulfilled" ? boostsS.value : [];

  const seen = new Set<string>();
  const candidates: Array<{ address: string }> = [];
  for (const t of [...profiles, ...boosts]) {
    const addr = (t as { tokenAddress?: string }).tokenAddress ?? "";
    const cid = (t as { chainId?: string }).chainId ?? "";
    if (!addr || cid !== chain) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ address: addr });
  }

  // If profiles/boosts feed has no tokens for this chain right now, fall back to
  // searching common meme keywords directly on DexScreener filtered to the chain.
  if (candidates.length === 0) {
    for (const term of ["meme", "pepe", "dog", "inu", "cat", "shib"]) {
      const { pairs } = await searchPairs(term, { limit: 10 }).catch(() => ({
        pairs: [] as DexPair[],
      }));
      for (const p of pairs) {
        if (p.chainId !== chain || (p.volume?.h24 ?? 0) === 0) continue;
        const addr = p.baseToken?.address ?? "";
        if (!addr) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ address: addr });
      }
    }
  }

  if (candidates.length === 0) {
    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: "category",
      chain: req.chain ?? "evm",
      summary: `No active memecoins found on ${chainLabel} right now. DexScreener's trending feed has nothing for this chain at the moment — try again shortly.`,
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
      subIntent: "CATEGORY",
    } satisfies ResearchResult);
    return true;
  }

  // Enrich candidates with pair data
  const enriched = (
    await Promise.all(
      candidates.slice(0, 15).map(async (c) => {
        try {
          const { pairs } = await searchPairs(c.address, { limit: 3 });
          const best = pairs
            .filter((p) => p.chainId === chain && (p.volume?.h24 ?? 0) > 0)
            .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
          if (!best?.baseToken?.address) return null;
          return {
            symbol: best.baseToken.symbol ?? "?",
            name: best.baseToken.name ?? "?",
            price: parseFloat(best.priceUsd ?? "0") || null,
            volume24h: best.volume?.h24 ?? 0,
            priceChange24h: best.priceChange?.h24 ?? null,
          };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 10);

  if (enriched.length === 0) {
    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: "category",
      chain: req.chain ?? "evm",
      summary: `No active memecoins with volume found on ${chainLabel} right now. Try again shortly.`,
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
      subIntent: "CATEGORY",
    } satisfies ResearchResult);
    return true;
  }

  const lines: string[] = [`Top active tokens on ${chainLabel} (DexScreener):\n`];
  let rank = 0;
  for (const c of enriched) {
    rank++;
    const price = c.price != null ? `$${c.price.toPrecision(4)}` : "n/a";
    const h24 =
      c.priceChange24h != null
        ? ` (${c.priceChange24h > 0 ? "+" : ""}${c.priceChange24h.toFixed(1)}%)`
        : "";
    const vol = c.volume24h > 0 ? ` | vol ${formatCompact(c.volume24h)}` : "";
    lines.push(`${rank}. ${c.symbol.toUpperCase()} — ${price}${h24}${vol}`);
  }

  bus.emit("RESEARCH_RESULT", {
    requestId: req.requestId,
    address: "category",
    chain: req.chain ?? "evm",
    summary: lines.join("\n"),
    safetyScore: null,
    priceUsd: null,
    liquidityUsd: null,
    flags: [],
    completedAt: Date.now(),
    subIntent: "CATEGORY",
  } satisfies ResearchResult);
  return true;
}

async function handleResearchRequest(
  req: ResearchRequest,
  llm?: LlmClient,
  arkham?: ArkhamClient,
  nansen?: NansenClient,
): Promise<void> {
  const subIntent: ResearchSubIntent = req.subIntent ?? "TOKEN_LOOKUP";
  log.agent("research", `request for ${req.address ?? req.tokenName ?? "unknown"} [${subIntent}]`);

  const toolSet = new Set<string>(
    req.tools && req.tools.length > 0 ? req.tools : TOOL_DEFAULTS[subIntent],
  );

  if (subIntent === "MARKET_OVERVIEW") {
    await handleMarketOverviewRequest(req, llm);
    return;
  }

  if (subIntent === "RESEARCH_WALLET") {
    const handled = await handleWalletRequest(req, arkham, llm);
    if (handled) return;
    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: req.address ?? "unknown",
      chain: req.chain ?? "evm",
      summary: req.address
        ? `Wallet intelligence for ${req.address} is not available right now. Arkham data is required but not configured.`
        : "Could not identify a wallet address in your query. Please include the full address.",
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
      subIntent: "RESEARCH_WALLET",
    } satisfies ResearchResult);
    return;
  }

  if (subIntent === "CATEGORY") {
    await handleCategoryRequest(req);
    return;
  }

  if (subIntent === "TRENDING") {
    await handleTrendingRequest(req, true);
    return;
  }
  if (!req.address && !req.tokenName) {
    const handled = await handleTrendingRequest(req);
    if (handled) return;
    bus.emit("RESEARCH_RESULT", {
      requestId: req.requestId,
      address: "unknown",
      chain: req.chain ?? "evm",
      summary:
        "I need a token address or name to look that up. Try asking about a specific token, or say 'what's trending' to see current movers.",
      safetyScore: null,
      priceUsd: null,
      liquidityUsd: null,
      flags: [],
      completedAt: Date.now(),
    } satisfies ResearchResult);
    return;
  }

  let address = req.address;
  const hintedChain = detectChainFromText(req.rawText ?? "");
  let resolvedChainId: DexScreenerChain = (
    hintedChain && isValidChain(hintedChain) ? hintedChain : "ethereum"
  ) as DexScreenerChain;

  if (!address && req.tokenName) {
    const { pairs } = await searchPairs(req.tokenName, { limit: 5 }).catch(() => ({
      query: "",
      pairs: [] as DexPair[],
      note: "",
    }));
    const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (top && isValidChain(top.chainId)) {
      address = top.baseToken.address;
      resolvedChainId = top.chainId as DexScreenerChain;
    }
  }

  if (!address) {
    console.log(`[research] could not resolve address for "${req.tokenName}"`);
    return;
  }

  const chainClass = detectChainClass(address);
  if (req.chain === "solana" || chainClass === "solana") resolvedChainId = "solana";

  let pairs = await getPairsByToken(resolvedChainId, address).catch(() => [] as DexPair[]);

  // If no pairs found on default chain, try other popular chains
  if (pairs.length === 0 && chainClass === "evm" && resolvedChainId === "ethereum") {
    const tryChains: DexScreenerChain[] = [
      "base",
      "arbitrum",
      "bsc",
      "polygon",
      "optimism",
      "avalanche",
    ];
    const multiResults = await Promise.allSettled(
      tryChains.map((c) => getPairsByToken(c, address)),
    );
    for (const r of multiResults) {
      if (r.status === "fulfilled" && r.value.length > 0) {
        pairs = r.value;
        resolvedChainId = r.value[0]!.chainId as DexScreenerChain;
        break;
      }
    }
  }

  const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  const ticker = best?.baseToken?.symbol ?? req.tokenName ?? address.slice(0, 8);
  const tokenName = best?.baseToken?.name ?? req.tokenName ?? ticker;
  const priceUsd = parseFloat(best?.priceUsd ?? "0") || null;
  const liquidityUsd = best?.liquidity?.usd ?? null;

  const priceChange = best?.priceChange
    ? {
        h1: best.priceChange.h1 ?? null,
        h6: best.priceChange.h6 ?? null,
        h24: best.priceChange.h24 ?? null,
      }
    : null;

  const [secS, ageS, trendS, cgS, birdS, braveS, geckoS, arkHoldersS, arkFlowsS, nansenS, duneS] =
    await Promise.allSettled([
      toolSet.has("goplus") || toolSet.has("honeypot")
        ? runSecurityScan(address, chainClass, resolvedChainId)
        : Promise.resolve({ flags: [] as SafetyFlag[], score: 100, ok: true }),
      toolSet.has("etherscan")
        ? checkAgeAndHolders(address, chainClass, resolvedChainId)
        : Promise.resolve({
            ageHours: null,
            top3Pct: null,
            holderCount: null,
            whaleAlert: null,
            distributingWallets: null,
          }),
      subIntent === "TOKEN_LOOKUP" || subIntent === "PRICE_ACTION"
        ? checkTrendSignal(ticker, tokenName, true)
        : Promise.resolve({ mentionCount: 0, sources: [] as string[], fearGreed: 50 }),
      toolSet.has("coingecko") ? fetchCoinGecko(ticker) : Promise.resolve(null),
      toolSet.has("birdeye") && chainClass === "solana"
        ? fetchBirdeye(address)
        : Promise.resolve(null),
      subIntent === "TOKEN_LOOKUP"
        ? searchBrave(`${ticker} ${tokenName} crypto`)
        : Promise.resolve([]),
      toolSet.has("geckoterminal")
        ? fetchGeckoTerminal(address, resolvedChainId)
        : Promise.resolve(null),
      toolSet.has("arkham") && arkham
        ? arkham.getTokenHolders(resolvedChainId, address, 10)
        : Promise.resolve([] as ArkhamHolder[]),
      toolSet.has("arkham") && arkham
        ? arkham.getTokenFlows(resolvedChainId, address, "24h", 10)
        : Promise.resolve([] as ArkhamFlow[]),
      toolSet.has("nansen") && nansen
        ? nansen.getSmartMoneyFlows(address, resolvedChainId)
        : Promise.resolve(null),
      toolSet.has("dune")
        ? fetchDuneSmartMoney(chainClass === "solana" ? "solana" : undefined)
        : Promise.resolve([] as DuneSmartMoneyFlow[]),
    ]);

  const security =
    secS.status === "fulfilled" ? secS.value : { flags: [] as SafetyFlag[], score: 50, ok: false };
  const age =
    ageS.status === "fulfilled"
      ? ageS.value
      : {
          ageHours: null,
          top3Pct: null,
          holderCount: null,
          whaleAlert: null,
          distributingWallets: null,
        };
  const trend =
    trendS.status === "fulfilled"
      ? trendS.value
      : { mentionCount: 0, sources: [] as string[], fearGreed: 50 };
  const cg = cgS.status === "fulfilled" ? cgS.value : null;
  const birdeye = birdS.status === "fulfilled" ? birdS.value : null;
  const brave = braveS.status === "fulfilled" ? braveS.value : [];
  const gecko = geckoS.status === "fulfilled" ? geckoS.value : null;
  const arkhamHolders = arkHoldersS.status === "fulfilled" ? arkHoldersS.value : [];
  const arkhamFlows = arkFlowsS.status === "fulfilled" ? arkFlowsS.value : [];
  const nansenFlows = nansenS.status === "fulfilled" ? nansenS.value : null;
  const duneFlows = duneS.status === "fulfilled" ? duneS.value : [];

  const tavilyHit = await checkTavily(ticker, 7);
  if (tavilyHit && !trend.sources.includes("tavily")) {
    trend.sources.push("tavily");
    trend.mentionCount++;
  }

  // Merge market-based flags with contract flags and recompute final score.
  const pairAgeHours = best?.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 3_600_000 : null;
  const top3Pct = age.top3Pct ?? null;
  const marketFlags = buildMarketFlags(
    liquidityUsd,
    best?.volume?.h24 ?? null,
    pairAgeHours,
    top3Pct,
  );
  if (marketFlags.length > 0) {
    const mergedResult = computeScore([
      ...security.flags.map((f) => ({ flag: f, source: "goplus" as const })),
      ...marketFlags,
    ]);
    security.score = mergedResult.score;
    for (const mf of mergedResult.flags) {
      if (!security.flags.includes(mf)) security.flags.push(mf);
    }
  }

  // Apply transfer-based adjustments before narrative multiplier.
  let baseScore = security.score;
  // Extra -20 for critically low liquidity (<$1k) on top of LOW_LIQUIDITY flag deduction.
  if (liquidityUsd !== null && liquidityUsd < 1_000) baseScore = Math.max(0, baseScore - 20);
  if (age.whaleAlert) baseScore = Math.max(0, baseScore - 15);
  if (age.distributingWallets) baseScore = Math.max(0, baseScore - age.distributingWallets * 5);
  if (arkhamHolders.length > 0) {
    const top3ArkhamPct = arkhamHolders.slice(0, 3).reduce((s, h) => s + h.percentage, 0);
    if (top3ArkhamPct > 60) baseScore = Math.max(0, baseScore - 10);
  }
  const smartMoneyNetFlow = (() => {
    let net = 0;
    if (nansenFlows?.smartMoney)
      net += nansenFlows.smartMoney.inflow - nansenFlows.smartMoney.outflow;
    if (arkhamFlows.length > 0) net += arkhamFlows.reduce((s, f) => s + f.netUSD, 0);
    return net;
  })();
  if (smartMoneyNetFlow < -50_000) baseScore = Math.max(0, baseScore - 5);
  else if (smartMoneyNetFlow > 50_000) baseScore = Math.min(100, baseScore + 5);

  const multiplier = computeNarrativeMultiplier(trend);
  const opportunityScore = Math.min(100, Math.round(baseScore * multiplier));

  const data: ResearchData = {
    ticker,
    tokenName,
    address,
    chainId: resolvedChainId,
    priceUsd,
    liquidityUsd,
    security,
    age,
    trend,
    cg,
    birdeye,
    brave,
    gecko,
    priceChange,
    arkhamHolders,
    arkhamFlows,
    nansenFlows,
    duneFlows,
    opportunityScore,
    question: req.question,
    subIntent,
  };

  let summary = await callLLM(buildResearchPrompt(data), llm);
  if (!summary) summary = buildTemplateSummary(data);

  bus.emit("RESEARCH_RESULT", {
    requestId: req.requestId,
    address,
    chain: chainClass,
    summary,
    safetyScore: baseScore,
    priceUsd,
    liquidityUsd,
    flags: security.flags,
    completedAt: Date.now(),
    tokenName,
    symbol: ticker,
    volume24h: best?.volume?.h24 ?? null,
    priceChange24h: priceChange?.h24 ?? null,
    fdv: best?.fdv ?? null,
    opportunityScore,
    subIntent,
    priceChange1h: priceChange?.h1 ?? null,
    pairAge: pairAgeHours,
    holderCount: age.holderCount ?? null,
    topHolderPct: top3Pct,
    fearGreed: trend.fearGreed,
    smartMoneyNetFlow,
    marketCap: cg?.marketCap ?? null,
    priceChange7d: null,
  } satisfies ResearchResult);

  console.log(`[research] RESEARCH_RESULT emitted for ${ticker} (opportunity=${opportunityScore})`);
}

// ─── Agent entry point ─────────────────────────────────────────────────────────
/**
 * Starts the Research Agent. Call once from src/index.ts at boot time.
 * Returns stop() for clean shutdown.
 *
 * @param deps.llm  Optional LlmClient (Israel's FallbackLlmClient). When provided,
 *                  all LLM synthesis uses it instead of a direct OgComputeClient.
 *
 * Job 1: background polling loop — emits ALPHA_FOUND for tokens that pass all gates.
 * Job 2: RESEARCH_REQUEST listener — emits RESEARCH_RESULT with synthesised verdict.
 */
export function startResearchAgent(deps?: {
  llm?: LlmClient;
  arkham?: ArkhamClient;
  nansen?: NansenClient;
}): { stop(): void } {
  _pollingArkham = deps?.arkham;
  void runPollingCycle();
  const timer = setInterval(() => {
    void runPollingCycle();
  }, POLL_INTERVAL_MS);

  const onRequest = (req: ResearchRequest) => {
    void handleResearchRequest(req, deps?.llm, deps?.arkham, deps?.nansen);
  };
  bus.on("RESEARCH_REQUEST", onRequest);

  console.log(
    "[research] Research Agent started — polling every 30s, listening for RESEARCH_REQUEST",
  );

  return {
    stop(): void {
      clearInterval(timer);
      bus.off("RESEARCH_REQUEST", onRequest);
    },
  };
}
