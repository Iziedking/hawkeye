// DexScreener HTTP client.
// Search is single-word only; chain filter is client-side; liquidity > $500M flagged as suspect.

export const BASE_URL = "https://api.dexscreener.com" as const;

export const USER_AGENT = "hawkeye-dexscreener-mcp/0.1 (HAWKEYE practice build)";

export const DEXSCREENER_CHAINS = [
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "base",
  "optimism",
  "avalanche",
  "fantom",
  "cronos",
  "zksync",
  "linea",
  "blast",
  "scroll",
  "mantle",
  "celo",
  "ronin",
  "solana",
  "sui",
  "aptos",
  "tron",
] as const;

export type DexScreenerChain = (typeof DEXSCREENER_CHAINS)[number];

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  txns?: {
    h24?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    m5?: { buys?: number; sells?: number };
  };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
}

export interface TokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type: string; label?: string; url: string }>;
}

export interface TokenBoost extends TokenProfile {
  amount: number;
  totalAmount: number;
}

export class DexScreenerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

class RateBucket {
  private timestamps: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0] ?? now;
      const waitMs = this.windowMs - (now - oldest) + 25;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.acquire();
    }
    this.timestamps.push(now);
  }
}

const bucketPairs = new RateBucket(280, 60_000); // headroom below 300 rpm
const bucketProfiles = new RateBucket(55, 60_000); // headroom below 60 rpm

type Bucket = "pairs" | "profiles";

async function request<T>(path: string, bucket: Bucket): Promise<T> {
  const b = bucket === "pairs" ? bucketPairs : bucketProfiles;
  await b.acquire();

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      redirect: "follow",
    });
  } catch (err) {
    throw new DexScreenerError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      path,
    );
  }

  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return request<T>(path, bucket);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DexScreenerError(
      `HTTP ${response.status} on ${path}: ${body.slice(0, 200)}`,
      response.status,
      path,
    );
  }
  return (await response.json()) as T;
}

function firstMeaningfulWord(query: string): string {
  return (
    query
      .trim()
      .split(/\s+/)
      .find((w) => w.length >= 2) ?? query.trim()
  );
}

export async function searchPairs(
  query: string,
  opts: { chain?: DexScreenerChain; limit?: number } = {},
): Promise<{ query: string; strippedFrom?: string; pairs: DexPair[]; note: string }> {
  const original = query.trim();
  const searchTerm = firstMeaningfulWord(original);
  const strippedFrom = searchTerm !== original ? original : undefined;

  const raw = await request<{ pairs?: DexPair[] }>(
    `/latest/dex/search/?q=${encodeURIComponent(searchTerm)}`,
    "pairs",
  );
  let pairs = raw.pairs ?? [];

  if (opts.chain) {
    pairs = pairs.filter((p) => p.chainId === opts.chain);
  }

  pairs = pairs.slice(0, opts.limit ?? 30);

  const suspiciousLiquidity = pairs.filter(
    (p) => typeof p.liquidity?.usd === "number" && p.liquidity.usd > 500_000_000,
  ).length;

  const note =
    (strippedFrom
      ? `Query stripped to single word "${searchTerm}" (DexScreener search is single-word only). `
      : "") +
    (suspiciousLiquidity > 0
      ? `${suspiciousLiquidity} pair(s) have liquidity > $500M — treat as likely bad data per LESSONS.md. `
      : "") +
    `Returned ${pairs.length} pair(s).`;

  return { query: searchTerm, ...(strippedFrom && { strippedFrom }), pairs, note };
}

export async function getPairsByToken(
  chain: DexScreenerChain,
  tokenAddress: string,
): Promise<DexPair[]> {
  return request<DexPair[]>(
    `/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`,
    "pairs",
  );
}

export async function getPair(
  chain: DexScreenerChain,
  pairAddress: string,
): Promise<DexPair | null> {
  const raw = await request<{ pair?: DexPair | null; pairs?: DexPair[] }>(
    `/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`,
    "pairs",
  );
  if (raw.pair) return raw.pair;
  return raw.pairs?.[0] ?? null;
}

export async function getTokens(
  chain: DexScreenerChain,
  tokenAddresses: string[],
): Promise<DexPair[]> {
  if (tokenAddresses.length === 0) return [];
  if (tokenAddresses.length > 30) {
    throw new DexScreenerError(
      `DexScreener tokens endpoint accepts at most 30 addresses; got ${tokenAddresses.length}.`,
    );
  }
  return request<DexPair[]>(
    `/tokens/v1/${encodeURIComponent(chain)}/${tokenAddresses.map(encodeURIComponent).join(",")}`,
    "pairs",
  );
}

export async function getLatestTokenProfiles(): Promise<TokenProfile[]> {
  return request<TokenProfile[]>("/token-profiles/latest/v1", "profiles");
}

export async function getLatestBoosts(): Promise<TokenBoost[]> {
  return request<TokenBoost[]>("/token-boosts/latest/v1", "profiles");
}

export async function getTopBoosts(): Promise<TokenBoost[]> {
  return request<TokenBoost[]>("/token-boosts/top/v1", "profiles");
}

export function isValidChain(chain: string): chain is DexScreenerChain {
  return (DEXSCREENER_CHAINS as readonly string[]).includes(chain);
}
