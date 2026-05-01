import { envOr } from "../../shared/env";

const BASE = "https://api.arkm.com";

const ARKHAM_CHAIN_MAP: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum_one",
  polygon: "polygon",
  bsc: "bsc",
  optimism: "optimism",
  avalanche: "avalanche",
  solana: "solana",
  tron: "tron",
  blast: "blast",
  scroll: "scroll",
  linea: "linea",
  mantle: "mantle",
};

function toArkhamChain(chain: string): string {
  return ARKHAM_CHAIN_MAP[chain] ?? chain;
}

export type ArkhamHolder = {
  entity: string | null;
  address: string;
  usd: number;
  balance: number;
  percentage: number;
};

export type ArkhamFlow = {
  entityName: string | null;
  entityType: string | null;
  address: string;
  inUSD: number;
  outUSD: number;
  netUSD: number;
};

export type ArkhamTrendingToken = {
  name: string | null;
  symbol: string | null;
  pricingID: string;
  price: number;
  price24hAgo: number;
  volume24h: number;
  change24hPct: number;
};

export type ArkhamTokenIntel = {
  name: string;
  symbol: string;
  pricingID: string;
  tvTicker: string | null;
};

export class ArkhamClient {
  private readonly apiKey: string;

  constructor() {
    const key = envOr("ARKHAM_API_KEY", "");
    if (!key) throw new Error("ARKHAM_API_KEY not set");
    this.apiKey = key;
  }

  private async get<T>(path: string, timeoutMs = 8_000): Promise<T> {
    const resp = await fetch(`${BASE}${path}`, {
      headers: { "API-Key": this.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      throw new Error(`Arkham ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    return resp.json() as Promise<T>;
  }

  async getTokenHolders(
    chain: string,
    address: string,
    limit = 10,
  ): Promise<ArkhamHolder[]> {
    const arkChain = toArkhamChain(chain);
    type HoldersResp = {
      holders?: Record<string, Array<{
        address?: string;
        entity?: { name?: string } | string;
        usd?: number;
        balance?: number;
        percentage?: number;
      }>>;
    };
    const data = await this.get<HoldersResp>(
      `/token/holders/${arkChain}/${address}?groupByEntity=true`,
    );
    const holders: ArkhamHolder[] = [];
    if (!data.holders) return holders;
    for (const [, chainHolders] of Object.entries(data.holders)) {
      for (const h of chainHolders) {
        const entityName = typeof h.entity === "string"
          ? h.entity
          : h.entity?.name ?? null;
        holders.push({
          entity: entityName,
          address: h.address ?? "",
          usd: h.usd ?? 0,
          balance: h.balance ?? 0,
          percentage: h.percentage ?? 0,
        });
      }
    }
    return holders
      .sort((a, b) => b.usd - a.usd)
      .slice(0, limit);
  }

  async getTokenFlows(
    chain: string,
    address: string,
    timeLast = "24h",
    limit = 10,
  ): Promise<ArkhamFlow[]> {
    const arkChain = toArkhamChain(chain);
    type FlowItem = {
      address?: {
        address?: string;
        arkhamEntity?: { name?: string; type?: string } | null;
      };
      inUSD?: number;
      outUSD?: number;
    };
    const data = await this.get<FlowItem[]>(
      `/token/top_flow/${arkChain}/${address}?timeLast=${timeLast}`,
      12_000,
    );
    if (!Array.isArray(data)) return [];
    return data
      .map((f) => ({
        entityName: f.address?.arkhamEntity?.name ?? null,
        entityType: f.address?.arkhamEntity?.type ?? null,
        address: f.address?.address ?? "",
        inUSD: f.inUSD ?? 0,
        outUSD: f.outUSD ?? 0,
        netUSD: (f.inUSD ?? 0) - (f.outUSD ?? 0),
      }))
      .sort((a, b) => Math.abs(b.netUSD) - Math.abs(a.netUSD))
      .slice(0, limit);
  }

  async getTrending(): Promise<ArkhamTrendingToken[]> {
    type TrendingItem = {
      name?: string | null;
      symbol?: string | null;
      pricingID?: string;
      price?: number;
      price24hAgo?: number;
      volume24h?: number;
    };
    const data = await this.get<TrendingItem[]>("/token/trending");
    if (!Array.isArray(data)) return [];
    return data.map((t) => {
      const price = t.price ?? 0;
      const prev = t.price24hAgo ?? price;
      return {
        name: t.name ?? null,
        symbol: t.symbol ?? null,
        pricingID: t.pricingID ?? "",
        price,
        price24hAgo: prev,
        volume24h: t.volume24h ?? 0,
        change24hPct: prev > 0 ? ((price - prev) / prev) * 100 : 0,
      };
    });
  }

  async getTokenIntel(chain: string, address: string): Promise<ArkhamTokenIntel | null> {
    const arkChain = toArkhamChain(chain);
    type IntelResp = {
      name?: string;
      symbol?: string;
      identifier?: { pricingID?: string };
      tvTicker?: string | null;
    };
    try {
      const data = await this.get<IntelResp>(
        `/intelligence/token/${arkChain}/${address}`,
      );
      if (!data.name) return null;
      return {
        name: data.name,
        symbol: data.symbol ?? "",
        pricingID: data.identifier?.pricingID ?? "",
        tvTicker: data.tvTicker ?? null,
      };
    } catch {
      return null;
    }
  }

  async getAddressIntel(address: string, chain = "ethereum"): Promise<{
    entity: string | null;
    entityType: string | null;
    labels: string[];
  }> {
    const arkChain = toArkhamChain(chain);
    type AddrResp = {
      arkhamEntity?: { name?: string; type?: string } | null;
      arkhamLabel?: { name?: string } | null;
    };
    try {
      const data = await this.get<AddrResp>(
        `/intelligence/address/${address}?chain=${arkChain}`,
      );
      return {
        entity: data.arkhamEntity?.name ?? null,
        entityType: data.arkhamEntity?.type ?? null,
        labels: data.arkhamLabel?.name ? [data.arkhamLabel.name] : [],
      };
    } catch {
      return { entity: null, entityType: null, labels: [] };
    }
  }
}
