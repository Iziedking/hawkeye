/**
 * Lightweight Safety Agent — for Sunday's testing
 *
 * Runs a basic GoPlus security check on the token address.
 * Emits SAFETY_RESULT with a score and flags.
 *
 * This is a minimal version — Samuel's full agent will replace this.
 */

import bus from "../shared/event-bus";
import { envOr } from "../shared/env";
import type {
  TradeIntent,
  SafetyReport,
  SafetyFlag,
  ChainId,
} from "../shared/types";

// ---------------------------------------------------------------------------
// GoPlus chain ID mapping (GoPlus uses numeric chain IDs)
// ---------------------------------------------------------------------------

const GOPLUS_CHAIN_MAP: Record<string, string> = {
  ethereum: "1",
  bsc: "56",
  polygon: "137",
  arbitrum: "42161",
  base: "8453",
  optimism: "10",
  avalanche: "43114",
  fantom: "250",
  cronos: "25",
  zksync: "324",
  linea: "59144",
  blast: "81457",
  scroll: "534352",
  mantle: "5000",
  celo: "42220",
};

// ---------------------------------------------------------------------------
// GoPlus token security check
// ---------------------------------------------------------------------------

interface GoPlusTokenSecurity {
  is_honeypot?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  is_blacklisted?: string;
  is_proxy?: string;
  is_open_source?: string;
  holder_count?: string;
  lp_holder_count?: string;
  lp_total_supply?: string;
}

async function checkGoPlus(
  address: string,
  dexChainId: string,
): Promise<{ flags: SafetyFlag[]; score: number; detail: unknown }> {
  const goplusChainId = GOPLUS_CHAIN_MAP[dexChainId];
  if (!goplusChainId) {
    return { flags: [], score: 50, detail: { reason: "chain not supported by GoPlus" } };
  }

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return { flags: [], score: 50, detail: { error: `GoPlus HTTP ${res.status}` } };
    }

    const data = (await res.json()) as {
      result?: Record<string, GoPlusTokenSecurity>;
    };

    const tokenData = data.result?.[address.toLowerCase()];
    if (!tokenData) {
      return { flags: [], score: 50, detail: { reason: "token not found in GoPlus" } };
    }

    const flags: SafetyFlag[] = [];
    let score = 100;

    // Honeypot
    if (tokenData.is_honeypot === "1") {
      flags.push("HONEYPOT");
      score -= 80;
    }

    // High tax
    const buyTax = parseFloat(tokenData.buy_tax ?? "0");
    const sellTax = parseFloat(tokenData.sell_tax ?? "0");
    if (buyTax > 0.1 || sellTax > 0.1) {
      flags.push("HIGH_TAX");
      score -= 20;
    }

    // Mint authority
    if (tokenData.is_mintable === "1") {
      flags.push("MINT_AUTHORITY");
      score -= 15;
    }

    // Blacklist
    if (tokenData.is_blacklisted === "1") {
      flags.push("BLACKLIST");
      score -= 15;
    }

    // Proxy contract
    if (tokenData.is_proxy === "1") {
      flags.push("PROXY_CONTRACT");
      score -= 10;
    }

    // Unverified (not open source)
    if (tokenData.is_open_source === "0") {
      flags.push("UNVERIFIED_CONTRACT");
      score -= 15;
    }

    return {
      flags,
      score: Math.max(score, 0),
      detail: tokenData,
    };
  } catch (err) {
    console.error("[SafetyLight] GoPlus check failed:", err);
    return { flags: [], score: 50, detail: { error: String(err) } };
  }
}

// ---------------------------------------------------------------------------
// DexScreener chain resolution
// ---------------------------------------------------------------------------

async function resolveChainFromDex(address: string): Promise<string | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{ chainId: string; liquidity?: { usd?: number } }>;
    };
    const pairs = (data.pairs ?? [])
      .filter((p) => (p.liquidity?.usd ?? 0) < 500_000_000)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return pairs[0]?.chainId ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent entry point
// ---------------------------------------------------------------------------

export function startLightSafetyAgent(): () => void {
  const handler = async (intent: TradeIntent): Promise<void> => {
    const start = Date.now();
    console.log(
      `[SafetyLight] Checking ${intent.address} for intentId=${intent.intentId}`,
    );

    // Resolve chain from DexScreener (per CONTRIBUTING.md: never hardcode chain IDs)
    const resolvedChain = await resolveChainFromDex(intent.address);
    const chainId = (resolvedChain ?? "ethereum") as ChainId;

    // Run GoPlus check
    const goplus = await checkGoPlus(intent.address, chainId);

    // Check liquidity from DexScreener
    let liquidityFlag = false;
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(intent.address)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          pairs?: Array<{ liquidity?: { usd?: number } }>;
        };
        const topLiq = data.pairs?.[0]?.liquidity?.usd ?? 0;
        if (topLiq < 1_000) {
          liquidityFlag = true;
        }
      }
    } catch {
      // Non-fatal
    }

    const flags = [...goplus.flags];
    let score = goplus.score;
    if (liquidityFlag) {
      flags.push("LOW_LIQUIDITY");
      score = Math.max(score - 15, 0);
    }

    const report: SafetyReport = {
      intentId: intent.intentId,
      address: intent.address,
      chainId,
      score,
      flags,
      sources: [
        {
          provider: "goplus",
          ok: goplus.flags.length === 0,
          detail: goplus.detail,
        },
        {
          provider: "dexscreener",
          ok: !liquidityFlag,
          detail: { liquidityCheck: !liquidityFlag },
        },
      ],
      completedAt: Date.now(),
    };

    bus.emit("SAFETY_RESULT", report);

    console.log(
      `[SafetyLight] SAFETY_RESULT — intentId=${intent.intentId} score=${score} ` +
        `flags=[${flags.join(",")}] chain=${chainId} elapsed=${Date.now() - start}ms`,
    );
  };

  bus.on("TRADE_REQUEST", handler);
  console.log("[SafetyLight] ✓ Listening for TRADE_REQUEST");

  return () => {
    bus.off("TRADE_REQUEST", handler);
  };
}
