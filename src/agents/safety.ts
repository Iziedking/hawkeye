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
//   Sui/Aptos  → GoPlus has string-ID endpoints for these but they're out of scope
//                for this build. Add checkGoPlusSui() / checkGoPlusAptos() here later.

import { bus } from "../shared/event-bus";
import type { TradeIntent, SafetyReport, SafetyFlag, ChainId } from "../shared/types";
import { searchPairs } from "../tools/dexscreener-mcp/client";

// ─── Token cache ──────────────────────────────────────────────────────────────
// Prevents re-scanning the same token within 5 minutes.
// Scam data doesn't change second-to-second, so aggressive caching is correct
// and protects the GoPlus free-tier rate limit (~30 req/min).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

// ─── Numeric chain ID map ─────────────────────────────────────────────────────
// GoPlus and Honeypot.is identify EVM chains by their EIP-155 numeric chain ID.
// We map from the DexScreener slug resolved during chain detection.
//
// Solana uses RugCheck (separate function below) — not this map.
// Sui and Aptos use GoPlus string-ID endpoints — not this map.
//
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
  unichain:   130,    // Uniswap L2, mainnet 2025
  gnosis:     100,    // Gnosis Chain (formerly xDAI)
  berachain:  80094,  // Berachain mainnet, launched 2025
  hyperevm:   999,    // HyperEVM — Hyperliquid's EVM layer (verify at chainlist.org)
  monad:      41454,  // Monad mainnet (verify chain ID at chainlist.org if GoPlus rejects)
  mode:       34443,
  worldchain: 480,
};

// ─── DexScreener chain resolution ─────────────────────────────────────────────
// TradeIntent.chain is only "evm" | "solana" — too broad for GoPlus.
// We search DexScreener by token address and pick the highest-liquidity pair
// to identify the canonical specific chain (e.g. "base", "unichain", "gnosis").
// DexScreener-first pattern per CONTRIBUTING.md — never hardcode chain IDs.
async function resolveChain(
  address: string,
  chainClass: "evm" | "solana",
): Promise<{ chainId: ChainId; liquidityUsd: number; priceUsd: number }> {
  // Solana is a single chain — no sub-chain resolution needed, just get liquidity.
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

  // EVM: search DexScreener with the token address and pick the pair with the
  // highest liquidity — this identifies which specific EVM chain the token lives on.
  // We filter out non-EVM chains that DexScreener also indexes.
  const NON_EVM_CHAINS = new Set(["solana", "sui", "aptos", "tron"]);
  try {
    const result = await searchPairs(address);
    const evmPairs = result.pairs
      .filter((p) => !NON_EVM_CHAINS.has(p.chainId))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    const best = evmPairs[0];
    if (!best) {
      // No EVM pairs found — assume Ethereum as the safest default.
      return { chainId: "ethereum", liquidityUsd: 0, priceUsd: 0 };
    }

    return {
      chainId: best.chainId as ChainId,
      liquidityUsd: best.liquidity?.usd ?? 0,
      priceUsd: parseFloat(best.priceUsd ?? "0") || 0,
    };
  } catch {
    // DexScreener unavailable — fall back to Ethereum. GoPlus will still run.
    return { chainId: "ethereum", liquidityUsd: 0, priceUsd: 0 };
  }
}

// ─── GoPlus security scan (EVM) ───────────────────────────────────────────────
// Primary EVM security oracle. Detects honeypots, high taxes, minting capability,
// proxy contracts, and whether the creator has a history of rugging.
// Free tier, unauthenticated — add GOPLUS_API_KEY + GOPLUS_API_SECRET to .env.local
// for higher rate limits if traffic exceeds ~30 req/min.
type GoPlusData = {
  is_honeypot?: string;       // "1" = buy/sell simulation confirms honeypot
  buy_tax?: string;           // decimal string: "0.05" = 5% tax on buys
  sell_tax?: string;          // decimal string: "0.10" = 10% tax on sells
  is_mintable?: string;       // "1" = owner can create new tokens (dilution risk)
  is_proxy?: string;          // "1" = upgradeable proxy — logic can change under the hood
  is_blacklisted?: string;    // "1" = contract has a blacklist mechanism
  is_open_source?: string;    // "1" = contract source verified on block explorer
  honeypot_with_same_creator?: string; // "1" = this creator has deployed rugs before
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
      // 8s timeout — GoPlus can lag under load but we can't stall the trade flow.
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };

    const body = await resp.json() as { code?: number; result?: Record<string, GoPlusData> };
    // GoPlus keys results by lowercased contract address.
    const data = body.result?.[address.toLowerCase()] ?? null;
    if (!data) return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };

    const flags: SafetyFlag[] = [];

    if (data.is_honeypot === "1")                flags.push("HONEYPOT");
    if (data.is_mintable === "1")                flags.push("MINT_AUTHORITY");
    if (data.is_proxy === "1")                   flags.push("PROXY_CONTRACT");
    if (data.is_blacklisted === "1")             flags.push("BLACKLIST");
    if (data.is_open_source !== "1")             flags.push("UNVERIFIED_CONTRACT");
    if (data.honeypot_with_same_creator === "1") flags.push("KNOWN_RUGGER");

    // GoPlus returns tax as decimal string ("0.1" = 10%). Flag if either side > 10%.
    const buyTax  = parseFloat(data.buy_tax  ?? "0");
    const sellTax = parseFloat(data.sell_tax ?? "0");
    if (buyTax > 0.1 || sellTax > 0.1) flags.push("HIGH_TAX");

    return { flags, ok: true, detail: data };
  } catch {
    // Network error or timeout — fail open with UNVERIFIED_CONTRACT so Strategy
    // Agent can ask the user to confirm rather than silently blocking the trade.
    return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };
  }
}

// ─── Honeypot.is (EVM only) ───────────────────────────────────────────────────
// Secondary honeypot check — a second simulation engine for a second opinion.
// Can catch cases GoPlus misses (different detection methodology).
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
    // Unavailable — don't penalize. GoPlus covers this check independently.
    return { isHoneypot: false, ok: false, detail: null };
  }
}

// ─── RugCheck (Solana only) ───────────────────────────────────────────────────
// Used for Solana tokens only. Honeypot.is is EVM-only per CONTRIBUTING.md.
// RugCheck detects freeze/mint authority, ownership concentration, and known rugs.
// No API key required.
type RugCheckRisk     = { name: string; description?: string; level?: string };
type RugCheckResponse = {
  risks?: RugCheckRisk[];
  score?: number;                   // RugCheck's scale: lower = riskier
  freezeAuthority?: string | null;  // non-null = issuer can freeze all transfers
  mintAuthority?: string | null;    // non-null = issuer can inflate supply at will
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

    // Freeze authority: issuer can halt all token transfers — a hard rug vector.
    if (report.freezeAuthority) flags.push("FREEZE_AUTHORITY");

    // Mint authority: issuer can create new tokens, diluting all existing holders.
    if (report.mintAuthority)   flags.push("MINT_AUTHORITY");

    // Walk the structured risk list and map each item to our SafetyFlag types.
    for (const risk of report.risks ?? []) {
      const name  = risk.name.toLowerCase();
      const level = risk.level?.toLowerCase();

      if (name.includes("honeypot") || name.includes("rugged")) flags.push("HONEYPOT");
      if (name.includes("freeze"))                              flags.push("FREEZE_AUTHORITY");
      if (name.includes("mint"))                                flags.push("MINT_AUTHORITY");
      if (name.includes("blacklist"))                           flags.push("BLACKLIST");
      if (level === "danger" && name.includes("tax"))           flags.push("HIGH_TAX");
    }

    // Deduplicate — freeze/mint can appear in both the authority fields and risk list.
    return { flags: [...new Set(flags)], ok: true, detail: report };
  } catch {
    return { flags: ["UNVERIFIED_CONTRACT"], ok: false, detail: null };
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
// Start at 100 and deduct per flag. Clamp to [0, 100].
//
// Strategy Agent thresholds (from types.ts):
//   >= 70  → trade proceeds
//   50–69  → Strategy asks user to confirm before executing
//   < 50   → rejected
//
// Weights are conservative: a false positive costs a missed trade,
// a false negative costs real money. We bias toward over-blocking.
const FLAG_DEDUCTIONS: Record<SafetyFlag, number> = {
  HONEYPOT:           100, // automatic zero — never trade a honeypot
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
// Orchestrates chain resolution, parallel security checks, and scoring.
async function scanToken(
  address: string,
  chainClass: "evm" | "solana",
  intentId: string,
): Promise<SafetyReport> {
  // Step 1: resolve the specific chain and pull liquidity data from DexScreener.
  // This completes first because we need the numeric chain ID for GoPlus + Honeypot.is.
  const { chainId, liquidityUsd, priceUsd } = await resolveChain(address, chainClass);

  const flags: SafetyFlag[] = [];
  const sources: SafetyReport["sources"] = [];

  // Step 2: low liquidity check from data already in hand — no extra API call needed.
  // Below $5k, a single trade can move the price 10%+ and exit is near-impossible.
  if (liquidityUsd > 0 && liquidityUsd < 5_000) {
    flags.push("LOW_LIQUIDITY");
  }

  if (chainClass === "evm") {
    // Use the numeric chain ID for GoPlus + Honeypot.is.
    // Default to Ethereum (1) if the chain isn't in our map (e.g. a very new chain).
    const numericId = CHAIN_NUMERIC_ID[chainId] ?? 1;

    // Step 3a (EVM): run GoPlus and Honeypot.is in parallel — both are independent calls.
    const [goplus, honeypot] = await Promise.all([
      checkGoPlus(address, numericId),
      checkHoneypotIs(address, numericId),
    ]);

    flags.push(...goplus.flags);
    sources.push({ provider: "goplus",   ok: goplus.ok,   detail: goplus.detail });

    // Honeypot.is provides a second opinion — add HONEYPOT if it caught what GoPlus missed.
    if (honeypot.isHoneypot && !flags.includes("HONEYPOT")) {
      flags.push("HONEYPOT");
    }
    sources.push({ provider: "honeypot", ok: honeypot.ok, detail: honeypot.detail });
  } else {
    // Step 3b (Solana): RugCheck replaces both scanners. Honeypot.is is EVM-only.
    const rugcheck = await checkRugCheck(address);
    flags.push(...rugcheck.flags);
    sources.push({ provider: "rugcheck", ok: rugcheck.ok, detail: rugcheck.detail });
  }

  // Record DexScreener as a named source in the 0G Storage audit trail.
  sources.push({
    provider: "dexscreener",
    ok: true,
    detail: { chainId, liquidityUsd, priceUsd },
  });

  // Deduplicate — parallel providers can return the same flag independently.
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
 *
 * Listens for TRADE_REQUEST and COPY_TRADE_REQUEST (both flow into the
 * safety pipeline per CONTRIBUTING.md). Emits SAFETY_RESULT when done.
 *
 * Strategy Agent uses: score >= 70 → proceed, 50-69 → confirm, < 50 → reject.
 * Results are cached per token address for 5 minutes.
 */
export function startSafetyAgent(): void {
  // Standard buy intent — user wants to trade a specific token.
  bus.on("TRADE_REQUEST", (intent: TradeIntent) => {
    void handleSafetyScan(intent);
  });

  // Copy-trade intent — user wants to mirror another wallet's trades.
  // We still scan the target token so we don't blindly copy into a honeypot.
  bus.on("COPY_TRADE_REQUEST", (intent: TradeIntent) => {
    if (!intent.address) return; // no token attached — nothing to scan
    void handleSafetyScan(intent);
  });

  console.log("[safety] Safety Agent started — listening for TRADE_REQUEST, COPY_TRADE_REQUEST");
}

async function handleSafetyScan(intent: TradeIntent): Promise<void> {
  const cacheKey = intent.address.toLowerCase();
  const cached = getCached(cacheKey);

  if (cached) {
    // Cache hit: return the stored result with this request's intentId.
    // The intentId changes per request, but the token's risk data is still valid.
    bus.emit("SAFETY_RESULT", { ...cached, intentId: intent.intentId });
    console.log(`[safety] cache hit ${intent.address} score=${cached.score}`);
    return;
  }

  console.log(`[safety] scanning ${intent.address} (${intent.chain})`);
  try {
    const report = await scanToken(intent.address, intent.chain, intent.intentId);

    // Cache without the intentId — same token can be reused across different intents.
    const { intentId: _omit, ...cacheable } = report;
    setCache(cacheKey, cacheable);

    bus.emit("SAFETY_RESULT", report);
    console.log(`[safety] ${intent.address} score=${report.score} flags=[${report.flags.join(",")}]`);
  } catch (err) {
    // Unexpected failure — emit a 50-score result so Strategy Agent asks the user
    // to confirm rather than silently blocking the trade.
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
