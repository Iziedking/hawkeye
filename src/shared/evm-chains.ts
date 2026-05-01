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
