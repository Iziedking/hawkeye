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
    rpcUrl: envOr("EVM_RPC_ETHEREUM", "https://rpc.ankr.com/eth"),
    fallbackRpc: "https://eth.llamarpc.com",
    explorerUrl: "https://etherscan.io",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  base: {
    chainId: "base",
    name: "Base",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_BASE", "https://rpc.ankr.com/base"),
    fallbackRpc: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
  polygon: {
    chainId: "polygon",
    name: "Polygon PoS",
    nativeCurrency: "MATIC",
    rpcUrl: envOr("EVM_RPC_POLYGON", "https://rpc.ankr.com/polygon"),
    fallbackRpc: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  arbitrum: {
    chainId: "arbitrum",
    name: "Arbitrum One",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_ARBITRUM", "https://rpc.ankr.com/arbitrum"),
    fallbackRpc: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  optimism: {
    chainId: "optimism",
    name: "Optimism",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_OPTIMISM", "https://rpc.ankr.com/optimism"),
    fallbackRpc: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
  bsc: {
    chainId: "bsc",
    name: "BNB Smart Chain",
    nativeCurrency: "BNB",
    rpcUrl: envOr("EVM_RPC_BSC", "https://rpc.ankr.com/bsc"),
    fallbackRpc: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  avalanche: {
    chainId: "avalanche",
    name: "Avalanche C-Chain",
    nativeCurrency: "AVAX",
    rpcUrl: envOr("EVM_RPC_AVALANCHE", "https://rpc.ankr.com/avalanche"),
    fallbackRpc: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  },
  fantom: {
    chainId: "fantom",
    name: "Fantom Opera",
    nativeCurrency: "FTM",
    rpcUrl: envOr("EVM_RPC_FANTOM", "https://rpc.ankr.com/fantom"),
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
    rpcUrl: envOr("EVM_RPC_ZKSYNC", "https://rpc.ankr.com/zksync_era"),
    fallbackRpc: "https://mainnet.era.zksync.io",
    explorerUrl: "https://explorer.zksync.io",
    wrappedNative: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
  },
  linea: {
    chainId: "linea",
    name: "Linea",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_LINEA", "https://rpc.ankr.com/linea"),
    fallbackRpc: "https://rpc.linea.build",
    explorerUrl: "https://lineascan.build",
    wrappedNative: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
  },
  blast: {
    chainId: "blast",
    name: "Blast",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_BLAST", "https://rpc.ankr.com/blast"),
    fallbackRpc: "https://rpc.blast.io",
    explorerUrl: "https://blastscan.io",
    wrappedNative: "0x4300000000000000000000000000000000000004",
  },
  scroll: {
    chainId: "scroll",
    name: "Scroll",
    nativeCurrency: "ETH",
    rpcUrl: envOr("EVM_RPC_SCROLL", "https://rpc.ankr.com/scroll"),
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
    rpcUrl: envOr("EVM_RPC_SEPOLIA", "https://rpc.ankr.com/eth_sepolia"),
    fallbackRpc: "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    wrappedNative: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
};

/**
 * Get the RPC URL for a chain, trying primary then fallback.
 */
export function getChainRpc(chainId: string): string {
  const cfg = EVM_CHAIN_CONFIG[chainId];
  return cfg?.rpcUrl ?? cfg?.fallbackRpc ?? "https://rpc.ankr.com/eth";
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
