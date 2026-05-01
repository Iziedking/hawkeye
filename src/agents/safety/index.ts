// Safety Agent — scans tokens for scam signals before any money moves.
// Listens for TRADE_REQUEST (and COPY_TRADE_REQUEST), runs parallel security
// checks via GoPlus, Honeypot.is, and RugCheck, then emits SAFETY_RESULT.
//
// No LLM. No SDK. Pure fetch() calls to free public APIs.
// GoPlus free tier: ~30 req/min unauthenticated — the 5-min token cache
// keeps us well under that limit even during high-frequency trading.
//
// Chain coverage:
//   EVM chains → GoPlus (EVM) + Honeypot.is
//   Solana     → GoPlus (Solana) + RugCheck
//   Testnet    → auto-pass (score=100, no API calls)
//
// Scoring: weighted by source reliability. Single-source flags are discounted;
// multi-source agreement triggers full deduction. Jupiter strict list applies
// a small bonus for vetted Solana tokens.

import { bus } from "../../shared/event-bus";
import type { TradeIntent, SafetyReport, SafetyFlag, ChainId } from "../../shared/types";
import { searchPairs } from "../../tools/dexscreener-mcp/client";

// ─── Token cache ──────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { data: Omit<SafetyReport, "intentId">; expiresAt: number };
const tokenCache = new Map<string, CacheEntry>();

function getCached(address: string): Omit<SafetyReport, "intentId"> | null {
  const entry = tokenCache.get(address.toLowerCase());
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setCache(address: string, data: Omit<SafetyReport, "intentId">): void {
  tokenCache.set(address.toLowerCase(), { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Testnet chains ───────────────────────────────────────────────────────────
const TESTNET_CHAIN_IDS = new Set<string>([
  "sepolia", "base-sepolia", "basesepolia", "goerli", "mumbai", "fuji",
]);

// ─── GoPlus retry delays ──────────────────────────────────────────────────────
// 429s happen when traffic bursts past the free-tier limit (~30 req/min).
// Two retries (1s, 2s delay) before failing open — never block a trade on a rate limit.
const GOPLUS_RETRY_DELAYS_MS = [1_000, 2_000] as const;

// ─── Weighted scoring infrastructure ─────────────────────────────────────────
// Each flag is tagged with the source that reported it. When only one source
// fires, the deduction is multiplied by that source's reliability weight.
// When multiple sources agree, full deduction applies — corroboration is certainty.
type FlagSource = "goplus" | "honeypot" | "rugcheck" | "goplusSolana" | "dexscreener";
type FlagWithSource = { flag: SafetyFlag; source: FlagSource };

const SOURCE_WEIGHTS: Record<FlagSource, number> = {
  goplus: 0.9,
  honeypot: 0.85,
  rugcheck: 0.85,
  goplusSolana: 0.85,
  dexscreener: 1.0,
};

// ─── Numeric chain ID map ─────────────────────────────────────────────────────
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

// ─── Scoring ──────────────────────────────────────────────────────────────────
// Start at 100, deduct per flag with source-reliability weighting.
// HONEYPOT always gets full deduction — a 90%-weight honeypot is still a honeypot.
// jupiterBonus: Jupiter strict-list membership subtracts 5 from total deduction.
const FLAG_DEDUCTIONS: Record<SafetyFlag, number> = {
  HONEYPOT: 100,
  KNOWN_RUGGER: 50,
  PHISHING_ORIGIN: 30,
  MINT_AUTHORITY: 25,
  FREEZE_AUTHORITY: 25,
  HIGH_TAX: 25,
  BLACKLIST: 20,
  LOW_LIQUIDITY: 20,
  UNVERIFIED_CONTRACT: 15,
  PROXY_CONTRACT: 10,
};

function computeScore(
  flagsWithSources: FlagWithSource[],
  jupiterBonus = false,
): { score: number; flags: SafetyFlag[] } {
  // Group by flag to detect multi-source agreement.
  const flagSources = new Map<SafetyFlag, Set<FlagSource>>();
  for (const { flag, source } of flagsWithSources) {
    if (!flagSources.has(flag)) flagSources.set(flag, new Set());
    flagSources.get(flag)!.add(source);
  }

  let deduction = 0;
  for (const [flag, sources] of flagSources) {
    const base = FLAG_DEDUCTIONS[flag] ?? 0;
    if (flag === "HONEYPOT" || sources.size >= 2) {
      deduction += base; // HONEYPOT always full; multi-source always full
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

// ─── DexScreener chain resolution ─────────────────────────────────────────────
async function resolveChain(
  address: string,
  chainClass: "evm" | "solana",
): Promise<{ chainId: ChainId; liquidityUsd: number; priceUsd: number }> {
  if (chainClass === "solana") {
    try {
      const result = await searchPairs(address);
      const pair = result.pairs
        .filter((p) => p.chainId === "solana")
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      return {
        chainId: "solana",
        liquidityUsd: pair?.liquidity?.usd ?? 0,
        priceUsd: parseFloat(pair?.priceUsd ?? "0") || 0,
      };
    } catch {
      return { chainId: "solana", liquidityUsd: 0, priceUsd: 0 };
    }
  }

  const NON_EVM_CHAINS = new Set(["solana", "sui", "aptos", "tron"]);
  try {
    const result = await searchPairs(address);
    const evmPairs = result.pairs
      .filter((p) => !NON_EVM_CHAINS.has(p.chainId))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = evmPairs[0];
    if (!best) return { chainId: "ethereum", liquidityUsd: 0, priceUsd: 0 };
    return {
      chainId: best.chainId as ChainId,
      liquidityUsd: best.liquidity?.usd ?? 0,
      priceUsd: parseFloat(best.priceUsd ?? "0") || 0,
    };
  } catch {
    return { chainId: "ethereum", liquidityUsd: 0, priceUsd: 0 };
  }
}

// ─── GoPlus authentication ────────────────────────────────────────────────────
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
    console.log("[safety] GoPlus access token obtained");
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

// ─── GoPlus EVM ───────────────────────────────────────────────────────────────
type GoPlusData = {
  is_honeypot?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_mintable?: string;
  is_proxy?: string;
  is_blacklisted?: string;
  is_open_source?: string;
  honeypot_with_same_creator?: string;
};

async function checkGoPlus(
  address: string,
  numericChainId: number,
): Promise<{ flags: FlagWithSource[]; ok: boolean; detail: GoPlusData | null }> {
  const url =
    `https://api.gopluslabs.io/api/v1/token_security/${numericChainId}` +
    `?contract_addresses=${address.toLowerCase()}`;

  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= GOPLUS_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = GOPLUS_RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      console.warn(`[safety] GoPlus 429 chain=${numericChainId} — retry ${attempt} in ${delay}ms`);
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
    } catch (err) {
      console.error(`[safety] GoPlus fetch error chain=${numericChainId}:`, err);
      return {
        flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplus" }],
        ok: false,
        detail: null,
      };
    }
  }

  if (!lastResp || !lastResp.ok) {
    if (lastResp?.status === 429) {
      console.warn(`[safety] GoPlus all retries exhausted chain=${numericChainId} — failing open`);
      return { flags: [], ok: false, detail: null };
    }
    return { flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplus" }], ok: false, detail: null };
  }

  try {
    const body = (await lastResp.json()) as { result?: Record<string, GoPlusData> };
    const data = body.result?.[address.toLowerCase()] ?? null;
    if (!data)
      return {
        flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplus" }],
        ok: false,
        detail: null,
      };

    const flags: FlagWithSource[] = [];
    if (data.is_honeypot === "1") flags.push({ flag: "HONEYPOT", source: "goplus" });
    if (data.is_mintable === "1") flags.push({ flag: "MINT_AUTHORITY", source: "goplus" });
    if (data.is_proxy === "1") flags.push({ flag: "PROXY_CONTRACT", source: "goplus" });
    if (data.is_blacklisted === "1") flags.push({ flag: "BLACKLIST", source: "goplus" });
    if (data.is_open_source !== "1") flags.push({ flag: "UNVERIFIED_CONTRACT", source: "goplus" });
    if (data.honeypot_with_same_creator === "1")
      flags.push({ flag: "KNOWN_RUGGER", source: "goplus" });
    const buyTax = parseFloat(data.buy_tax ?? "0");
    const sellTax = parseFloat(data.sell_tax ?? "0");
    if (buyTax > 0.1 || sellTax > 0.1) flags.push({ flag: "HIGH_TAX", source: "goplus" });

    return { flags, ok: true, detail: data };
  } catch {
    return { flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplus" }], ok: false, detail: null };
  }
}

// ─── Honeypot.is (EVM only) ───────────────────────────────────────────────────
type HoneypotIsResponse = {
  isHoneypot?: boolean;
  simulationResult?: { buyTax?: number; sellTax?: number };
  simulationSuccess?: boolean;
};

async function checkHoneypotIs(
  address: string,
  numericChainId: number,
): Promise<{ flags: FlagWithSource[]; ok: boolean; detail: HoneypotIsResponse | null }> {
  try {
    const resp = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${numericChainId}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) },
    );
    if (!resp.ok) return { flags: [], ok: false, detail: null };
    const body = (await resp.json()) as HoneypotIsResponse;
    const flags: FlagWithSource[] =
      body.isHoneypot === true ? [{ flag: "HONEYPOT", source: "honeypot" }] : [];
    return { flags, ok: true, detail: body };
  } catch {
    return { flags: [], ok: false, detail: null };
  }
}

// ─── RugCheck (Solana) ────────────────────────────────────────────────────────
type RugCheckRisk = { name: string; description?: string; level?: string };
type RugCheckResponse = {
  risks?: RugCheckRisk[];
  score?: number;
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
};

async function checkRugCheck(
  mintAddress: string,
): Promise<{ flags: FlagWithSource[]; ok: boolean; detail: RugCheckResponse | null }> {
  try {
    const resp = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok)
      return {
        flags: [{ flag: "UNVERIFIED_CONTRACT", source: "rugcheck" }],
        ok: false,
        detail: null,
      };

    const report = (await resp.json()) as RugCheckResponse;
    const flags: FlagWithSource[] = [];

    if (report.freezeAuthority) flags.push({ flag: "FREEZE_AUTHORITY", source: "rugcheck" });
    if (report.mintAuthority) flags.push({ flag: "MINT_AUTHORITY", source: "rugcheck" });

    for (const risk of report.risks ?? []) {
      const name = risk.name.toLowerCase();
      const level = risk.level?.toLowerCase();
      if (name.includes("honeypot") || name.includes("rugged"))
        flags.push({ flag: "HONEYPOT", source: "rugcheck" });
      if (name.includes("freeze")) flags.push({ flag: "FREEZE_AUTHORITY", source: "rugcheck" });
      if (name.includes("mint")) flags.push({ flag: "MINT_AUTHORITY", source: "rugcheck" });
      if (name.includes("blacklist")) flags.push({ flag: "BLACKLIST", source: "rugcheck" });
      if (level === "danger" && name.includes("tax"))
        flags.push({ flag: "HIGH_TAX", source: "rugcheck" });
    }

    // Deduplicate by flag+source pair
    const seen = new Set<string>();
    const unique = flags.filter(({ flag, source }) => {
      const key = `${flag}:${source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { flags: unique, ok: true, detail: report };
  } catch {
    return {
      flags: [{ flag: "UNVERIFIED_CONTRACT", source: "rugcheck" }],
      ok: false,
      detail: null,
    };
  }
}

// ─── GoPlus Solana ────────────────────────────────────────────────────────────
// Dedicated Solana endpoint — different fields from the EVM endpoint.
// Runs alongside RugCheck for dual-scanner coverage on Solana tokens.
// NOTE: Solana addresses are base58 case-sensitive — do NOT .toLowerCase() the key lookup.
type GoPlusSolanaData = {
  is_mintable?: string;
  freezeable?: string;
  metadata_upgradeable?: string;
  transfer_fee_enable?: string;
  transfer_fee_rate?: string;
  hidden_owner?: string;
  non_transferable?: string;
  closeable?: string;
};

async function checkGoPlusSolana(
  mintAddress: string,
): Promise<{ flags: FlagWithSource[]; ok: boolean; detail: GoPlusSolanaData | null }> {
  const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mintAddress}`;

  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= GOPLUS_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = GOPLUS_RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      console.warn(`[safety] GoPlus Solana 429 — retry ${attempt} in ${delay}ms`);
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
    } catch (err) {
      console.error("[safety] GoPlus Solana fetch error:", err);
      return {
        flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }],
        ok: false,
        detail: null,
      };
    }
  }

  if (!lastResp || !lastResp.ok) {
    if (lastResp?.status === 429) {
      console.warn("[safety] GoPlus Solana all retries exhausted — failing open");
      return { flags: [], ok: false, detail: null };
    }
    return {
      flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }],
      ok: false,
      detail: null,
    };
  }

  try {
    const body = (await lastResp.json()) as { result?: Record<string, GoPlusSolanaData> };
    // Solana address lookup is case-sensitive — use mintAddress as-is
    const data = body.result?.[mintAddress] ?? null;
    if (!data)
      return {
        flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }],
        ok: false,
        detail: null,
      };

    const flags: FlagWithSource[] = [];
    if (data.freezeable === "1") flags.push({ flag: "FREEZE_AUTHORITY", source: "goplusSolana" });
    if (data.is_mintable === "1") flags.push({ flag: "MINT_AUTHORITY", source: "goplusSolana" });
    if (parseFloat(data.transfer_fee_rate ?? "0") > 0.1)
      flags.push({ flag: "HIGH_TAX", source: "goplusSolana" });

    return { flags, ok: true, detail: data };
  } catch {
    return {
      flags: [{ flag: "UNVERIFIED_CONTRACT", source: "goplusSolana" }],
      ok: false,
      detail: null,
    };
  }
}

// ─── Jupiter strict token list ────────────────────────────────────────────────
// Tokens on Jupiter's strict list have been manually vetted by the Jupiter team.
// Membership is a positive signal — we apply a -5 deduction bonus for these tokens.
// Cache for 1 hour (the list changes rarely). Fail open on network error.
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
    console.warn("[safety] Jupiter strict list unavailable — skipping bonus");
    return false;
  }
}

// ─── Age and holder concentration ─────────────────────────────────────────────
// Ported from research agent. Used here to score down very new tokens and
// tokens with extreme holder concentration — without hard-dropping them
// (users can override; safety agent never hard-rejects a trade).
type AgeAndHolders = {
  ageHours: number | null;
  top3Pct: number | null;
  holderCount: number | null;
};

async function checkAgeAndHolders(
  address: string,
  chainClass: "evm" | "solana",
  chainId: string,
): Promise<AgeAndHolders> {
  return chainClass === "evm" ? checkEtherscan(address, chainId) : checkSolscan(address);
}

// Maps DexScreener chain IDs to their block explorer API. All use the same Etherscan API format.
const ETHERSCAN_EXPLORER: Record<string, { url: string; keyEnv: string }> = {
  ethereum: { url: "https://api.etherscan.io/api",    keyEnv: "ETHERSCAN_API_KEY" },
  base:     { url: "https://api.basescan.org/api",    keyEnv: "BASESCAN_API_KEY" },
  arbitrum: { url: "https://api.arbiscan.io/api",     keyEnv: "ARBISCAN_API_KEY" },
  bsc:      { url: "https://api.bscscan.com/api",     keyEnv: "BSCSCAN_API_KEY" },
  polygon:  { url: "https://api.polygonscan.com/api", keyEnv: "POLYGONSCAN_API_KEY" },
};

async function checkEtherscan(address: string, chainId: string): Promise<AgeAndHolders> {
  const explorer = ETHERSCAN_EXPLORER[chainId] ?? ETHERSCAN_EXPLORER["ethereum"]!;
  const key = process.env[explorer.keyEnv] ?? "";
  if (!key) return { ageHours: null, top3Pct: null, holderCount: null };
  const base = explorer.url;
  try {
    const [ageResp, holdersResp, supplyResp] = await Promise.all([
      fetch(
        `${base}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
      fetch(
        `${base}?module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
      fetch(`${base}?module=stats&action=tokensupply&contractaddress=${address}&apikey=${key}`, {
        signal: AbortSignal.timeout(8_000),
      }),
    ]);

    let ageHours: number | null = null;
    if (ageResp.ok) {
      const body = (await ageResp.json()) as { result?: Array<{ timeStamp?: string }> };
      const ts = parseInt(body.result?.[0]?.timeStamp ?? "0", 10);
      if (ts > 0) ageHours = (Date.now() / 1000 - ts) / 3600;
    }

    let top3Pct: number | null = null;
    let holderCount: number | null = null;
    if (holdersResp.ok && supplyResp.ok) {
      const holdersBody = (await holdersResp.json()) as {
        result?: Array<{ TokenHolderQuantity?: string }>;
      };
      const supplyBody = (await supplyResp.json()) as { result?: string };
      const totalSupply = parseFloat(supplyBody.result ?? "0");
      const holders = holdersBody.result ?? [];
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
    return { ageHours: null, top3Pct: null, holderCount: null };
  }
}

async function checkSolscan(address: string): Promise<AgeAndHolders> {
  const base = "https://public-api.solscan.io";
  try {
    const [metaResp, holdersResp] = await Promise.all([
      fetch(`${base}/token/meta?tokenAddress=${address}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(`${base}/token/holders?tokenAddress=${address}&limit=10&offset=0`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      }),
    ]);

    let ageHours: number | null = null;
    if (metaResp.ok) {
      const body = (await metaResp.json()) as { tokenInfo?: { tokenCreatedAt?: number } };
      const createdAt = body.tokenInfo?.tokenCreatedAt;
      if (createdAt) ageHours = (Date.now() / 1000 - createdAt) / 3600;
    }

    let top3Pct: number | null = null;
    let holderCount: number | null = null;
    if (holdersResp.ok) {
      const body = (await holdersResp.json()) as {
        total?: number;
        data?: Array<{ amount?: number }>;
      };
      holderCount = body.total ?? null;
      const holders = body.data ?? [];
      if (holders.length >= 3) {
        const amounts = holders.map((h) => h.amount ?? 0);
        const totalInList = amounts.reduce((a, b) => a + b, 0);
        if (totalInList > 0) {
          const top3 = amounts.slice(0, 3).reduce((a, b) => a + b, 0);
          top3Pct = (top3 / totalInList) * 100;
        }
      }
    }
    return { ageHours, top3Pct, holderCount };
  } catch {
    return { ageHours: null, top3Pct: null, holderCount: null };
  }
}

// ─── Full token scan ──────────────────────────────────────────────────────────
async function scanToken(
  address: string,
  chainClass: "evm" | "solana",
  intentId: string,
  chainHint?: string,
): Promise<SafetyReport> {
  // Check chainHint first — DexScreener doesn't index testnet tokens
  if (chainHint && TESTNET_CHAIN_IDS.has(chainHint)) {
    console.log(`[safety] testnet auto-pass for ${address} (chainHint=${chainHint})`);
    return {
      intentId,
      address,
      chainId: chainHint as ChainId,
      score: 100,
      flags: [],
      sources: [{ provider: "dexscreener", ok: true, detail: { note: "testnet — auto-pass" } }],
      completedAt: Date.now(),
    };
  }

  const { chainId, liquidityUsd, priceUsd } = await resolveChain(address, chainClass);

  // Fallback: DexScreener resolved to a testnet chain
  if (TESTNET_CHAIN_IDS.has(chainId)) {
    console.log(`[safety] testnet auto-pass for ${address} (${chainId})`);
    return {
      intentId,
      address,
      chainId: chainId as ChainId,
      score: 100,
      flags: [],
      sources: [{ provider: "dexscreener", ok: true, detail: { note: "testnet — auto-pass" } }],
      completedAt: Date.now(),
    };
  }

  const allFlags: FlagWithSource[] = [];
  const sources: SafetyReport["sources"] = [];

  // Low liquidity check — derived from DexScreener data already in hand.
  if (liquidityUsd > 0 && liquidityUsd < 5_000) {
    allFlags.push({ flag: "LOW_LIQUIDITY", source: "dexscreener" });
  }

  let jupiterBonus = false;

  if (chainClass === "evm") {
    const numericId = CHAIN_NUMERIC_ID[chainId] ?? 1;
    const [goplus, honeypot] = await Promise.all([
      checkGoPlus(address, numericId),
      checkHoneypotIs(address, numericId),
    ]);
    allFlags.push(...goplus.flags, ...honeypot.flags);
    sources.push({ provider: "goplus", ok: goplus.ok, detail: goplus.detail });
    sources.push({ provider: "honeypot", ok: honeypot.ok, detail: honeypot.detail });
  } else {
    // Solana: dual scanner — RugCheck + GoPlus Solana + Jupiter strict list check in parallel.
    const [rugcheck, goplusSol, onStrict] = await Promise.all([
      checkRugCheck(address),
      checkGoPlusSolana(address),
      isOnJupiterStrictList(address),
    ]);
    allFlags.push(...rugcheck.flags, ...goplusSol.flags);
    sources.push({ provider: "rugcheck", ok: rugcheck.ok, detail: rugcheck.detail });
    // Use provider:"goplus" for the sources array (type constraint); _solana flag tracks the detail.
    sources.push({
      provider: "goplus",
      ok: goplusSol.ok,
      detail: { ...goplusSol.detail, _solana: true },
    });
    jupiterBonus = onStrict;
    if (onStrict) console.log(`[safety] ${address}: on Jupiter strict list — applying bonus`);
  }

  // Run age/holder check in parallel with security scans would require restructuring.
  // Running after security is fine — uses different APIs (Etherscan/Solscan vs GoPlus/RugCheck).
  const ageHolders = await checkAgeAndHolders(address, chainClass, chainId);

  // Very new token — flag with LOW_LIQUIDITY to trigger AWAIT_USER_CONFIRM without hard-dropping.
  if (ageHolders.ageHours !== null && ageHolders.ageHours < 1) {
    allFlags.push({ flag: "LOW_LIQUIDITY", source: "dexscreener" });
    console.log(
      `[safety] ${address}: very new token (${ageHolders.ageHours.toFixed(1)}h) — adding LOW_LIQUIDITY flag`,
    );
  }

  sources.push({ provider: "dexscreener", ok: true, detail: { chainId, liquidityUsd, priceUsd } });

  const computed = computeScore(allFlags, jupiterBonus);
  let score = computed.score;
  const flags = computed.flags;

  // Concentration penalty — top 3 holders > 80% of supply suggests coordinated dump setup.
  // Applied post-score so it doesn't interfere with the weighted deduction logic.
  // Not a hard SafetyFlag (would require changing types.ts) — just a score reduction.
  if (ageHolders.top3Pct !== null && ageHolders.top3Pct > 80) {
    score = Math.max(0, score - 20);
    console.log(
      `[safety] ${address}: high holder concentration (${ageHolders.top3Pct.toFixed(0)}%) — score -20`,
    );
  }

  // TODO(israel): add resolvedChainId: chainId once SafetyReport gains resolvedChainId?: string
  return { intentId, address, chainId, score, flags, sources, completedAt: Date.now() };
}

// ─── Agent entry point ────────────────────────────────────────────────────────
/**
 * Starts the Safety Agent. Call once from src/index.ts at boot time.
 * Returns stop() for clean shutdown.
 *
 * Listens for TRADE_REQUEST and COPY_TRADE_REQUEST. Emits SAFETY_RESULT.
 *
 * Strategy Agent contract:
 *   score >= 70  → EXECUTE
 *   score 50–69  → AWAIT_USER_CONFIRM
 *   score < 50   → AWAIT_USER_CONFIRM — show SafetyReport.flags[] plainly, never hard-reject.
 */
export function startSafetyAgent(): { stop(): void } {
  const onTrade = (intent: TradeIntent) => {
    void handleSafetyScan(intent);
  };
  const onCopy = (intent: TradeIntent) => {
    if (!intent.address) return;
    void handleSafetyScan(intent);
  };

  bus.on("TRADE_REQUEST", onTrade);
  bus.on("COPY_TRADE_REQUEST", onCopy);
  console.log("[safety] Safety Agent started — listening for TRADE_REQUEST, COPY_TRADE_REQUEST");

  return {
    stop(): void {
      bus.off("TRADE_REQUEST", onTrade);
      bus.off("COPY_TRADE_REQUEST", onCopy);
    },
  };
}

async function handleSafetyScan(intent: TradeIntent): Promise<void> {
  const cacheKey = intent.address.toLowerCase();
  const cached = getCached(cacheKey);

  if (cached) {
    bus.emit("SAFETY_RESULT", { ...cached, intentId: intent.intentId });
    console.log(`[safety] cache hit ${intent.address} score=${cached.score}`);
    return;
  }

  console.log(`[safety] scanning ${intent.address} (${intent.chain})`);
  try {
    const report = await scanToken(intent.address, intent.chain, intent.intentId, intent.chainHint);
    const { intentId: _omit, ...cacheable } = report;
    setCache(cacheKey, cacheable);
    bus.emit("SAFETY_RESULT", report);
    console.log(
      `[safety] ${intent.address} score=${report.score} flags=[${report.flags.join(",")}]`,
    );
  } catch (err) {
    const fallback: SafetyReport = {
      intentId: intent.intentId,
      address: intent.address,
      chainId: intent.chain === "solana" ? "solana" : "ethereum",
      score: 50,
      flags: ["UNVERIFIED_CONTRACT"],
      sources: [{ provider: "goplus", ok: false, detail: { error: String(err) } }],
      completedAt: Date.now(),
    };
    bus.emit("SAFETY_RESULT", fallback);
    console.error(`[safety] scan error for ${intent.address}:`, err);
  }
}
