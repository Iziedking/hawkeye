import { envOr } from "../../shared/env";

const BASE = "https://api.nansen.ai/v1";

const NANSEN_CHAIN_MAP: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  bsc: "bsc",
  polygon: "polygon",
  optimism: "optimism",
  avalanche: "avalanche",
  solana: "solana",
};

export type NansenFlows = {
  smartMoney: { inflow: number; outflow: number } | null;
  whales: { inflow: number; outflow: number } | null;
  label: string | null;
};

type CacheEntry = { value: NansenFlows; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1_000;

export class NansenClient {
  private readonly apiKey: string;

  constructor() {
    this.apiKey = envOr("NANSEN_API_KEY", "");
  }

  async getSmartMoneyFlows(address: string, chainId: string): Promise<NansenFlows | null> {
    if (!this.apiKey) return null;

    const chain = NANSEN_CHAIN_MAP[chainId];
    if (!chain) return null;

    const cacheKey = `${chain}:${address.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const resp = await fetch(
        `${BASE}/token/${chain}/${address.toLowerCase()}/recent-flows-summary`,
        {
          headers: { apikey: this.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!resp.ok) return null;

      const body = (await resp.json()) as {
        data?: Array<{ segment?: string; inflow_usd?: number; outflow_usd?: number }>;
        label?: string;
      };

      const segments = body.data ?? [];
      const sm = segments.find((s) => s.segment?.toLowerCase().includes("smart"));
      const wh = segments.find((s) => s.segment?.toLowerCase().includes("whale"));

      const result: NansenFlows = {
        smartMoney: sm ? { inflow: sm.inflow_usd ?? 0, outflow: sm.outflow_usd ?? 0 } : null,
        whales: wh ? { inflow: wh.inflow_usd ?? 0, outflow: wh.outflow_usd ?? 0 } : null,
        label: body.label ?? null,
      };

      cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch {
      return null;
    }
  }
}
