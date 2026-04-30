export const SAFETY_PASS_SCORE = 70;
export const SAFETY_CONFIRM_SCORE = 50;
export const SAFETY_CACHE_TTL_MS = 5 * 60 * 1_000;

export const STRATEGY_MERGE_TIMEOUT_MS = 10_000;
export const STRATEGY_CONFIRM_EXPIRY_MS = 60_000;

export const QUOTE_API_TIMEOUT_MS = 8_000;

export const RESEARCH_SCAN_INTERVAL_MS = 30_000;
export const RESEARCH_CACHE_TTL_MS = 5 * 60 * 1_000;
export const ALPHA_COOLDOWN_MS = 30 * 60 * 1_000;
export const ALPHA_MIN_LIQUIDITY_USD = 10_000;
export const ALPHA_MIN_SAFETY_SCORE = 50;

export const MONITOR_POLL_INTERVAL_MS = 10_000;
export const MONITOR_MAX_CONSECUTIVE_ERRORS = 5;

export const EXECUTION_CACHE_TTL_MS = 5 * 60 * 1_000;

export const LLM_TIMEOUT_MS = 8_000;
export const LLM_MIN_CONFIDENCE = 0.3;

export const API_TIMEOUT_MS = 8_000;
export const HONEYPOT_TIMEOUT_MS = 6_000;

export const CONVERSATION_MAX_MESSAGES = 10;
export const CONVERSATION_TTL_MS = 30 * 60 * 1_000;

export const OG_TESTNET_CHAIN_ID = 16602;
export const OG_TESTNET_RPC = "https://evmrpc-testnet.0g.ai";
export const OG_MAINNET_CHAIN_ID = 16661;
export const OG_MAINNET_RPC = "https://evmrpc.0g.ai";
export const OG_MAINNET_EXPLORER = "https://chainscan.0g.ai";

export const PRIVY_SUPPORTED_CHAINS = [
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "base",
  "optimism",
  "avalanche",
  "blast",
  "zksync",
  "celo",
  "scroll",
  "linea",
  "mantle",
  "fantom",
  "cronos",
] as const;
