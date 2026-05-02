type ChainTokens = Record<string, string>;

// Well-known token addresses per chain. Native tokens use the wrapped address.
const KNOWN_TOKENS: Record<string, ChainTokens> = {
  ethereum: {
    ETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    PEPE: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  },
  base: {
    ETH: "0x4200000000000000000000000000000000000006",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    DEGEN: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
  },
  arbitrum: {
    ETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
  },
  optimism: {
    ETH: "0x4200000000000000000000000000000000000006",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    OP: "0x4200000000000000000000000000000000000042",
  },
  polygon: {
    MATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  },
  bsc: {
    BNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
  },
  avalanche: {
    AVAX: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    WAVAX: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    USDT: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  },
  // Sepolia testnet
  sepolia: {
    ETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
};

// Normalize chain name from user input
const CHAIN_ALIASES: Record<string, string> = {
  eth: "ethereum",
  ethereum: "ethereum",
  mainnet: "ethereum",
  base: "base",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  op: "optimism",
  optimism: "optimism",
  poly: "polygon",
  polygon: "polygon",
  matic: "polygon",
  bsc: "bsc",
  bnb: "bsc",
  binance: "bsc",
  avax: "avalanche",
  avalanche: "avalanche",
  sepolia: "sepolia",
  sep: "sepolia",
  sol: "solana",
  solana: "solana",
};

export type ResolvedToken = {
  address: string;
  symbol: string;
  chain: string;
  source: "known" | "dexscreener";
  name?: string;
  liquidity?: number;
};

export function resolveChainAlias(input: string): string | null {
  return CHAIN_ALIASES[input.toLowerCase()] ?? null;
}

export function lookupKnownToken(symbol: string, chain?: string): ResolvedToken | null {
  const sym = symbol.toUpperCase();
  if (chain) {
    const resolved = resolveChainAlias(chain) ?? chain.toLowerCase();
    const tokens = KNOWN_TOKENS[resolved];
    if (tokens && tokens[sym]) {
      return { address: tokens[sym]!, symbol: sym, chain: resolved, source: "known" };
    }
    return null;
  }
  // Default to ethereum if no chain specified
  const ethTokens = KNOWN_TOKENS["ethereum"];
  if (ethTokens && ethTokens[sym]) {
    return { address: ethTokens[sym]!, symbol: sym, chain: "ethereum", source: "known" };
  }
  return null;
}

type DexPair = {
  chainId: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  liquidity?: { usd?: number };
};

type DexSearchResponse = {
  pairs?: DexPair[];
};

export async function searchDexScreener(
  query: string,
  chain?: string,
): Promise<ResolvedToken | null> {
  // DexScreener search is single-word only
  const word = query.trim().split(/\s+/)[0];
  if (!word) return null;

  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(word)}`,
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as DexSearchResponse;
    if (!data.pairs || data.pairs.length === 0) return null;

    let candidates = data.pairs;

    // Filter by chain if specified
    if (chain) {
      const resolved = resolveChainAlias(chain) ?? chain.toLowerCase();
      candidates = candidates.filter((p) => p.chainId.toLowerCase() === resolved);
    }

    if (candidates.length === 0) return null;

    // Sort by liquidity descending, pick best
    candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = candidates[0]!;

    const sym = query.toUpperCase();
    // Return whichever token in the pair matches the query
    const base = best.baseToken;
    const quote = best.quoteToken;
    const match =
      base.symbol.toUpperCase() === sym ? base : quote.symbol.toUpperCase() === sym ? quote : base;

    const liq = best.liquidity?.usd;
    const result: ResolvedToken = {
      address: match.address,
      symbol: match.symbol,
      chain: best.chainId,
      source: "dexscreener",
      name: match.name,
    };
    if (liq !== undefined) result.liquidity = liq;
    return result;
  } catch {
    return null;
  }
}

// Reverse lookup: given a contract address, find which chain and symbol it belongs to.
// Critical for testnet tokens that DexScreener can't index.
export function lookupKnownAddress(address: string): ResolvedToken | null {
  const lower = address.toLowerCase();
  for (const [chainName, tokens] of Object.entries(KNOWN_TOKENS)) {
    for (const [symbol, addr] of Object.entries(tokens)) {
      if (addr.toLowerCase() === lower) {
        return { address: addr, symbol, chain: chainName, source: "known" };
      }
    }
  }
  return null;
}

export async function resolveToken(symbol: string, chain?: string): Promise<ResolvedToken | null> {
  const known = lookupKnownToken(symbol, chain);
  if (known) return known;

  return searchDexScreener(symbol, chain);
}
