/**
 * EVM Chain Registry — multi-chain RPC provider map.
 *
 * Ankr RPCs are primary (loaded from .env.local).
 * Public endpoints are hardcoded as fallbacks.
 *
 * Usage:
 *   import { getChainRpc, getChainExplorer, EVM_CHAIN_CONFIG } from "../shared/evm-chains";
 */

import { envOr } from "./env";
import type { ChainId } from "./types";

export type EvmChainConfig = {
  chainId: ChainId;
  name: string;
  nativeCurrency: string;
  rpcUrl: string;
  fallbackRpc: string;
  explorerUrl: string;
  explorerApi?: string;
  wrappedNative: string; // WETH/WBNB/WMATIC etc.
};

/**
 * All supported EVM chains. Solana/Sui/Aptos/Tron are excluded from this phase.
 */
export const EVM_CHAIN_CONFIG: Record<string, EvmChainConfig> = {
  ethereum: {
    chainId: "ethereum",
    name: "Ethereum",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"),
    fallbackRpc: "https://cloudflare-eth.com",
    explorerUrl: "https://etherscan.io",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  base: {
    chainId: "base",
    name: "Base",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_BASE", "https://base-rpc.publicnode.com"),
    fallbackRpc: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
  polygon: {
    chainId: "polygon",
    name: "Polygon PoS",
    nativeCurrency: "MATIC",
    rpcUrl: envOr("EVM_RPC_POLYGON", "https://polygon-bor-rpc.publicnode.com"),
    fallbackRpc: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  arbitrum: {
    chainId: "arbitrum",
    name: "Arbitrum One",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_ARBITRUM", "https://arbitrum-one-rpc.publicnode.com"),
    fallbackRpc: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  optimism: {
    chainId: "optimism",
    name: "Optimism",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_OPTIMISM", "https://optimism-rpc.publicnode.com"),
    fallbackRpc: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
  bsc: {
    chainId: "bsc",
    name: "BNB Smart Chain",
    nativeCurrency: "BNB",
    rpcUrl: envOr("EVM_RPC_BSC", "https://bsc-rpc.publicnode.com"),
    fallbackRpc: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  avalanche: {
    chainId: "avalanche",
    name: "Avalanche C-Chain",
    nativeCurrency: "AVAX",
    rpcUrl: envOr("EVM_RPC_AVALANCHE", "https://avalanche-c-chain-rpc.publicnode.com"),
    fallbackRpc: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  },
  fantom: {
    chainId: "fantom",
    name: "Fantom Opera",
    nativeCurrency: "FTM",
    rpcUrl: envOr("EVM_RPC_FANTOM", "https://fantom-rpc.publicnode.com"),
    fallbackRpc: "https://rpc.ftm.tools",
    explorerUrl: "https://ftmscan.com",
    wrappedNative: "0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83",
  },
  cronos: {
    chainId: "cronos",
    name: "Cronos",
    nativeCurrency: "CRO",
    rpcUrl: envOr("EVM_RPC_CRONOS", "https://evm.cronos.org"),
    fallbackRpc: "https://evm.cronos.org",
    explorerUrl: "https://cronoscan.com",
    wrappedNative: "0x5C7F8A570d578ED60E5e2B4565cA910aF0688621",
  },
  zksync: {
    chainId: "zksync",
    name: "zkSync Era",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_ZKSYNC", "https://mainnet.era.zksync.io"),
    fallbackRpc: "https://mainnet.era.zksync.io",
    explorerUrl: "https://explorer.zksync.io",
    wrappedNative: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
  },
  linea: {
    chainId: "linea",
    name: "Linea",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_LINEA", "https://rpc.linea.build"),
    fallbackRpc: "https://rpc.linea.build",
    explorerUrl: "https://lineascan.build",
    wrappedNative: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
  },
  blast: {
    chainId: "blast",
    name: "Blast",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_BLAST", "https://rpc.blast.io"),
    fallbackRpc: "https://rpc.blast.io",
    explorerUrl: "https://blastscan.io",
    wrappedNative: "0x4300000000000000000000000000000000000004",
  },
  scroll: {
    chainId: "scroll",
    name: "Scroll",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_SCROLL", "https://scroll-rpc.publicnode.com"),
    fallbackRpc: "https://rpc.scroll.io",
    explorerUrl: "https://scrollscan.com",
    wrappedNative: "0x5300000000000000000000000000000000000004",
  },
  mantle: {
    chainId: "mantle",
    name: "Mantle",
    nativeCurrency: "MNT",
    rpcUrl: envOr("EVM_RPC_MANTLE", "https://rpc.mantle.xyz"),
    fallbackRpc: "https://rpc.mantle.xyz",
    explorerUrl: "https://explorer.mantle.xyz",
    wrappedNative: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
  },
  celo: {
    chainId: "celo",
    name: "Celo",
    nativeCurrency: "CELO",
    rpcUrl: envOr("EVM_RPC_CELO", "https://forno.celo.org"),
    fallbackRpc: "https://forno.celo.org",
    explorerUrl: "https://celoscan.io",
    wrappedNative: "0x471EcE3750Da237f93B8E339c536989b8978a438",
  },
  sepolia: {
    chainId: "sepolia",
    name: "Sepolia Testnet",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_SEPOLIA", "https://ethereum-sepolia-rpc.publicnode.com"),
    fallbackRpc: "https://rpc2.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    wrappedNative: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
  "base-sepolia": {
    chainId: "base-sepolia",
    name: "Base Sepolia Testnet",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_BASE_SEPOLIA", "https://sepolia.base.org"),
    fallbackRpc: "https://base-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.basescan.org",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
};

/**
 * Get the primary RPC URL for a chain.
 */
export function getChainRpc(chainId: string): string {
  const cfg = EVM_CHAIN_CONFIG[chainId];
  return cfg?.rpcUrl ?? cfg?.fallbackRpc ?? "https://ethereum-rpc.publicnode.com";
}

/**
 * Get the fallback RPC URL for a chain.
 */
export function getChainFallbackRpc(chainId: string): string {
  const cfg = EVM_CHAIN_CONFIG[chainId];
  return cfg?.fallbackRpc ?? cfg?.rpcUrl ?? "https://ethereum-rpc.publicnode.com";
}

/**
 * Fetch native balance with automatic fallback to secondary RPC on failure.
 */
export async function fetchNativeBalance(
  chainId: string,
  address: string,
  timeoutMs = 5_000,
): Promise<{ balance: bigint; chain: string; error?: string }> {
  const rpcs = [getChainRpc(chainId), getChainFallbackRpc(chainId)];
  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await resp.json()) as { result?: string; error?: { message?: string } };
      if (data.error) continue;
      if (!data.result) continue;
      return { balance: BigInt(data.result), chain: chainId };
    } catch {
      continue;
    }
  }
  return { balance: 0n, chain: chainId, error: "rpc_failed" };
}

/**
 * Fetch ERC-20 token balance via balanceOf(address).
 * Returns raw token units (not adjusted for decimals).
 */
export async function fetchTokenBalance(
  chainId: string,
  tokenAddress: string,
  walletAddress: string,
  timeoutMs = 5_000,
): Promise<{ balance: bigint; error?: string }> {
  const rpcs = [getChainRpc(chainId), getChainFallbackRpc(chainId)];
  const paddedWallet = walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const callData = `0x70a08231${paddedWallet}`;

  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: callData }, "latest"],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await resp.json()) as { result?: string; error?: { message?: string } };
      if (data.error) continue;
      if (!data.result || data.result === "0x") return { balance: 0n };
      return { balance: BigInt(data.result) };
    } catch {
      continue;
    }
  }
  return { balance: 0n, error: "rpc_failed" };
}

export type TokenAsset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  contractAddress: string;
  balance: string;
  balanceUsd: string;
  tokenPrice: string;
  thumbnail: string;
};

type WellKnownToken = { address: string; symbol: string; decimals: number };

const WELL_KNOWN_TOKENS: Record<string, WellKnownToken[]> = {
  ethereum: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
  ],
  base: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  ],
  arbitrum: [
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
  ],
  polygon: [
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
  ],
  optimism: [
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", decimals: 6 },
  ],
  bsc: [
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
  ],
};

export async function fetchTokenDecimals(chainId: string, tokenAddress: string): Promise<number> {
  const rpcs = [getChainRpc(chainId), getChainFallbackRpc(chainId)];
  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: "0x313ce567" }, "latest"],
        }),
        signal: AbortSignal.timeout(3_000),
      });
      const data = (await resp.json()) as { result?: string };
      if (data.result && data.result !== "0x") return Number(BigInt(data.result));
    } catch {
      continue;
    }
  }
  return 18;
}

async function fetchTokenSymbol(chainId: string, tokenAddress: string): Promise<string> {
  const rpcs = [getChainRpc(chainId), getChainFallbackRpc(chainId)];
  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: "0x95d89b41" }, "latest"],
        }),
        signal: AbortSignal.timeout(3_000),
      });
      const data = (await resp.json()) as { result?: string };
      if (data.result && data.result.length > 66) {
        const hex = data.result.slice(130);
        const bytes = Buffer.from(hex, "hex");
        return bytes.toString("utf8").replace(/\0/g, "").trim();
      }
    } catch {
      continue;
    }
  }
  return tokenAddress.slice(0, 8);
}

export type ExtraTokenCheck = {
  address: string;
  chainId: string;
  symbol?: string | undefined;
};

/**
 * Fetch token holdings via direct RPC balanceOf calls.
 * Checks well-known stablecoins on each chain plus any extra tokens
 * (e.g. from tracked positions). No API key required.
 */
export async function fetchTokenHoldings(
  walletAddress: string,
  chains: string[] = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"],
  _timeoutMs = 10_000,
  extraTokens: ExtraTokenCheck[] = [],
): Promise<{ assets: TokenAsset[]; totalBalanceUsd: string; error?: string }> {
  const assets: TokenAsset[] = [];
  const checked = new Set<string>();

  const checks: Array<{ chainId: string; token: WellKnownToken }> = [];

  for (const chain of chains) {
    const knownTokens = WELL_KNOWN_TOKENS[chain] ?? [];
    for (const t of knownTokens) {
      const key = `${chain}:${t.address.toLowerCase()}`;
      if (!checked.has(key)) {
        checked.add(key);
        checks.push({ chainId: chain, token: t });
      }
    }
  }

  for (const extra of extraTokens) {
    const key = `${extra.chainId}:${extra.address.toLowerCase()}`;
    if (checked.has(key)) continue;
    checked.add(key);
    checks.push({
      chainId: extra.chainId,
      token: { address: extra.address, symbol: extra.symbol ?? "???", decimals: -1 },
    });
  }

  const results = await Promise.allSettled(
    checks.map(async ({ chainId, token }) => {
      const { balance, error } = await fetchTokenBalance(
        chainId,
        token.address,
        walletAddress,
        5_000,
      );
      if (error || balance === 0n) return null;

      let decimals = token.decimals;
      let symbol = token.symbol;
      if (decimals < 0) {
        [decimals, symbol] = await Promise.all([
          fetchTokenDecimals(chainId, token.address),
          token.symbol === "???"
            ? fetchTokenSymbol(chainId, token.address)
            : Promise.resolve(token.symbol),
        ]);
      }

      const humanBalance = formatTokenBalance(balance, decimals);
      return {
        blockchain: chainId,
        tokenName: symbol,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        contractAddress: token.address,
        balance: humanBalance,
        balanceUsd: "0",
        tokenPrice: "0",
        thumbnail: "",
      } satisfies TokenAsset;
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) assets.push(r.value);
  }

  return { assets, totalBalanceUsd: "0" };
}

function formatTokenBalance(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Get the block explorer URL for a chain.
 */
export function getChainExplorer(chainId: string): string {
  return EVM_CHAIN_CONFIG[chainId]?.explorerUrl ?? "https://etherscan.io";
}

/**
 * Get the chain name for display.
 */
export function getChainName(chainId: string): string {
  return EVM_CHAIN_CONFIG[chainId]?.name ?? chainId;
}

/**
 * Get all supported EVM chain IDs.
 */
export function getSupportedChains(): string[] {
  return Object.keys(EVM_CHAIN_CONFIG);
}

/**
 * Check if a chain is supported.
 */
export function isEvmChain(chainId: string): boolean {
  return chainId in EVM_CHAIN_CONFIG;
}
