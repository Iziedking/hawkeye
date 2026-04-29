// Safety Agent — scans tokens for scam signals before any money moves.
// Listens for TRADE_REQUEST (and COPY_TRADE_REQUEST), runs parallel security
// checks via GoPlus, Honeypot.is, and RugCheck, then emits SAFETY_RESULT.
//
// No LLM. No SDK. Pure fetch() calls to free public APIs.
// GoPlus free tier: ~30 req/min unauthenticated — the 5-min token cache
// keeps us well under that limit even during high-frequency trading.
//
// Chain coverage:
//   EVM chains → GoPlus (numeric chain ID) + Honeypot.is
//   Solana     → RugCheck (Honeypot.is is EVM-only per CONTRIBUTING.md)
//   Testnet    → auto-pass (score=100, no API calls)

import { bus } from "../../shared/event-bus";
import type { TradeIntent, SafetyReport, SafetyFlag, ChainId } from "../../shared/types";
import { searchPairs } from "../../tools/dexscreener-mcp/client";

// ─── Token cache ──────────────────────────────────────────────────────────────
// Prevents re-scanning the same token within 5 minutes.
// Scam data doesn't change second-to-second, so aggressive caching is correct
// and protects the GoPlus free-tier rate limit (~30 req/min).
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
// Testnet tokens should never fail safety scans — auto-pass with score=100.
const TESTNET_CHAIN_IDS = new Set<string>(["sepolia"]);

// ─── Numeric chain ID map ─────────────────────────────────────────────────────
// GoPlus and Honeypot.is identify EVM chains by their EIP-155 numeric chain ID.
// We map from the DexScreener slug resolved during chain detection.
//
// Solana uses RugCheck (separate function below) — not this map.
// To add a new chain: look up its EIP-155 chain ID at chainlist.org and add it here.
const CHAIN_NUMERIC_ID: Record<string, number> = {
  ethereum:   1,
  bsc:        56,
  polygon:    137,
  arbitrum:   42161,
  base:       8453,
  optimism:   10,
  avalanche:  43114,
  fantom:     250,
  cronos:     25,
  zksync:     324,
  linea:      59144,
  blast:      81457,
  scroll:     534352,
  mantle:     5000,
  celo:       42220,
  ronin:      2020,
  unichain:   130,
  gnosis:     100,
  berachain:  80094,
  hyperevm:   999,
  monad:      41454,
  mode:       34443,
  worldchain: 480,
};

// ─── DexScreener chain resolution ─────────────────────────────────────────────
// TradeIntent.chain is only "evm" | "solana" — too broad for GoPlus.
// We search DexScreener by token address and pick the highest-liquidity pair
// to identify the canonical specific chain (e.g. "base", "unichain", "gnosis").
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

// ─── GoPlus security scan (EVM) ───────────────────────────────────────────────
// Primary EVM security oracle. Detects honeypots, high taxes, minting capability,
// proxy contracts, and whether the creator has a history of rugging.
// Free tier, unauthenticated — add GOPLUS_API_KEY + GOPLUS_API_SECRET to .env.local
// for higher rate limits if traffic exceeds ~30 req/min.
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
): Promise<{ flags: SafetyFlag[]; ok: boolean; detail: GoPlusData | null }> {
  try {
    const url =
      `https://api.gopluslabs.io/api/v1/token_security/${numericChainId}` +
      `?contract_addresses=${address.toLowerCase()}`;

    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    // Rate limited — fail open without penalising the token.
    // GoPlus 429s happen when traffic bursts; the cache prevents most repeat calls.
    if (resp.status === 429) {
      console.warn(`[safety] GoPlus rate limited (429) chain=${numericChainId} — failing open`);
      return { flags: [], ok: false, detail: null };
    }

    if (!resp.ok) return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };

    const body = await resp.json() as { code?: number; result?: Record<string, GoPlusData> };
    const data = body.result?.[address.toLowerCase()] ?? null;
    if (!data) return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };

    const flags: SafetyFlag[] = [];

    if (data.is_honeypot === "1")                flags.push("HONEYPOT");
    if (data.is_mintable === "1")                flags.push("MINT_AUTHORITY");
    if (data.is_proxy === "1")                   flags.push("PROXY_CONTRACT");
    if (data.is_blacklisted === "1")             flags.push("BLACKLIST");
    if (data.is_open_source !== "1")             flags.push("UNVERIFIED_CONTRACT");
    if (data.honeypot_with_same_creator === "1") flags.push("KNOWN_RUGGER");

    const buyTax  = parseFloat(data.buy_tax  ?? "0");
    const sellTax = parseFloat(data.sell_tax ?? "0");
    if (buyTax > 0.1 || sellTax > 0.1) flags.push("HIGH_TAX");

    return { flags, ok: true, detail: data };
  } catch {
    return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };
  }
}

// ─── Honeypot.is (EVM only) ───────────────────────────────────────────────────
// Secondary honeypot check — a second simulation engine for a second opinion.
// EVM-only per CONTRIBUTING.md. No API key required.
type HoneypotIsResponse = {
  isHoneypot?: boolean;
  simulationResult?: { buyTax?: number; sellTax?: number };
  simulationSuccess?: boolean;
};

async function checkHoneypotIs(
  address: string,
  numericChainId: number,
): Promise<{ isHoneypot: boolean; ok: boolean; detail: HoneypotIsResponse | null }> {
  try {
    const url =
      `https://api.honeypot.is/v2/IsHoneypot` +
      `?address=${address}&chainID=${numericChainId}`;

    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });

    if (!resp.ok) return { isHoneypot: false, ok: false, detail: null };

    const body = await resp.json() as HoneypotIsResponse;
    return { isHoneypot: body.isHoneypot === true, ok: true, detail: body };
  } catch {
    return { isHoneypot: false, ok: false, detail: null };
  }
}

// ─── RugCheck (Solana only) ───────────────────────────────────────────────────
// Used for Solana tokens only. Honeypot.is is EVM-only per CONTRIBUTING.md.
// RugCheck detects freeze/mint authority, ownership concentration, and known rugs.
type RugCheckRisk     = { name: string; description?: string; level?: string };
type RugCheckResponse = {
  risks?: RugCheckRisk[];
  score?: number;
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
};

async function checkRugCheck(
  mintAddress: string,
): Promise<{ flags: SafetyFlag[]; ok: boolean; detail: RugCheckResponse | null }> {
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };

    const report = await resp.json() as RugCheckResponse;
    const flags: SafetyFlag[] = [];

    if (report.freezeAuthority) flags.push("FREEZE_AUTHORITY");
    if (report.mintAuthority)   flags.push("MINT_AUTHORITY");

    for (const risk of report.risks ?? []) {
      const name  = risk.name.toLowerCase();
      const level = risk.level?.toLowerCase();

      if (name.includes("honeypot") || name.includes("rugged")) flags.push("HONEYPOT");
      if (name.includes("freeze"))                              flags.push("FREEZE_AUTHORITY");
      if (name.includes("mint"))                                flags.push("MINT_AUTHORITY");
      if (name.includes("blacklist"))                           flags.push("BLACKLIST");
      if (level === "danger" && name.includes("tax"))           flags.push("HIGH_TAX");
    }

    return { flags: [...new Set(flags)], ok: true, detail: report };
  } catch {
    return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
// Start at 100 and deduct per flag. Clamp to [0, 100].
//
// Intended Strategy Agent thresholds:
//   score >= 70  → EXECUTE
//   score 50–69  → AWAIT_USER_CONFIRM
//   score < 50   → AWAIT_USER_CONFIRM — show all flags plainly, let user decide.
//                  Never hard-reject a user-initiated trade.
const FLAG_DEDUCTIONS: Record<SafetyFlag, number> = {
  HONEYPOT:           100,
  KNOWN_RUGGER:        50,
  PHISHING_ORIGIN:     30,
  MINT_AUTHORITY:      25,
  FREEZE_AUTHORITY:    25,
  HIGH_TAX:            25,
  BLACKLIST:           20,
  LOW_LIQUIDITY:       20,
  UNVERIFIED_CONTRACT: 15,
  PROXY_CONTRACT:      10,
};

function computeScore(flags: SafetyFlag[]): number {
  const deduction = flags.reduce((total, flag) => total + (FLAG_DEDUCTIONS[flag] ?? 0), 0);
  return Math.max(0, 100 - deduction);
}

// ─── Full token scan ──────────────────────────────────────────────────────────
async function scanToken(
  address: string,
  chainClass: "evm" | "solana",
  intentId: string,
): Promise<SafetyReport> {
  const { chainId, liquidityUsd, priceUsd } = await resolveChain(address, chainClass);

  // Testnet tokens auto-pass — no point running security checks on test deployments.
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

  const flags: SafetyFlag[] = [];
  const sources: SafetyReport["sources"] = [];

  if (liquidityUsd > 0 && liquidityUsd < 5_000) {
    flags.push("LOW_LIQUIDITY");
  }

  if (chainClass === "evm") {
    const numericId = CHAIN_NUMERIC_ID[chainId] ?? 1;

    const [goplus, honeypot] = await Promise.all([
      checkGoPlus(address, numericId),
      checkHoneypotIs(address, numericId),
    ]);

    flags.push(...goplus.flags);
    sources.push({ provider: "goplus",   ok: goplus.ok,   detail: goplus.detail });

    if (honeypot.isHoneypot && !flags.includes("HONEYPOT")) {
      flags.push("HONEYPOT");
    }
    sources.push({ provider: "honeypot", ok: honeypot.ok, detail: honeypot.detail });
  } else {
    const rugcheck = await checkRugCheck(address);
    flags.push(...rugcheck.flags);
    sources.push({ provider: "rugcheck", ok: rugcheck.ok, detail: rugcheck.detail });
  }

  sources.push({
    provider: "dexscreener",
    ok: true,
    detail: { chainId, liquidityUsd, priceUsd },
  });

  const uniqueFlags = [...new Set(flags)] as SafetyFlag[];

  return {
    intentId,
    address,
    chainId,
    score: computeScore(uniqueFlags),
    flags: uniqueFlags,
    sources,
    completedAt: Date.now(),
  };
}

// ─── Agent entry point ────────────────────────────────────────────────────────
/**
 * Starts the Safety Agent. Call once from src/index.ts at boot time.
 * Returns a stop() function for clean shutdown.
 *
 * Listens for TRADE_REQUEST and COPY_TRADE_REQUEST. Emits SAFETY_RESULT.
 *
 * Strategy Agent contract:
 *   score >= 70  → EXECUTE
 *   score 50–69  → AWAIT_USER_CONFIRM
 *   score < 50   → AWAIT_USER_CONFIRM — show SafetyReport.flags[] plainly, never hard-reject.
 */
export function startSafetyAgent(): { stop(): void } {
  const onTrade = (intent: TradeIntent) => { void handleSafetyScan(intent); };
  const onCopy  = (intent: TradeIntent) => {
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
    const report = await scanToken(intent.address, intent.chain, intent.intentId);
    const { intentId: _omit, ...cacheable } = report;
    setCache(cacheKey, cacheable);
    bus.emit("SAFETY_RESULT", report);
    console.log(`[safety] ${intent.address} score=${report.score} flags=[${report.flags.join(",")}]`);
  } catch (err) {
    const fallback: SafetyReport = {
      intentId:    intent.intentId,
      address:     intent.address,
      chainId:     intent.chain === "solana" ? "solana" : "ethereum",
      score:       50,
      flags:       ["UNVERIFIED_CONTRACT"],
      sources:     [{ provider: "goplus", ok: false, detail: { error: String(err) } }],
      completedAt: Date.now(),
    };
    bus.emit("SAFETY_RESULT", fallback);
    console.error(`[safety] scan error for ${intent.address}:`, err);
  }
}
