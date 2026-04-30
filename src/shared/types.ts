export type ChainClass = "evm" | "solana";

export const CHAIN_IDS = [
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
  "sepolia",
] as const;

export type ChainId = (typeof CHAIN_IDS)[number];

export type AmountUnit = "NATIVE" | "USD" | "TOKEN";

export type TradeAmount = {
  value: number;
  unit: AmountUnit;
};

export type ExitTarget =
  | { kind: "multiplier"; value: number } // e.g. 3x
  | { kind: "price"; usd: number } // e.g. $0.42
  | { kind: "fdv"; usd: number } // e.g. FDV $10M
  | { kind: "marketcap"; usd: number }; // e.g. MC $5M

export type PartialExit = {
  percent: number;
  target: ExitTarget;
};

export type TradingMode = "INSTANT" | "NORMAL" | "CAREFUL";

export type MessageChannel =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage"
  | "webchat";

export type TradeIntent = {
  intentId: string;
  userId: string;
  channel: MessageChannel;
  address: string;
  chain: ChainClass;
  amount: TradeAmount;
  exits: PartialExit[];
  urgency: TradingMode;
  rawText: string;
  createdAt: number;
  chainHint?: ChainId;
};

export type SafetyFlag =
  | "HONEYPOT"
  | "HIGH_TAX"
  | "MINT_AUTHORITY"
  | "FREEZE_AUTHORITY"
  | "UNVERIFIED_CONTRACT"
  | "LOW_LIQUIDITY"
  | "BLACKLIST"
  | "PROXY_CONTRACT"
  | "KNOWN_RUGGER"
  | "PHISHING_ORIGIN";

export type SafetyReport = {
  intentId: string;
  address: string;
  chainId: ChainId;
  score: number; // 0-100, >= 70 passes Strategy threshold
  flags: SafetyFlag[];
  sources: Array<{
    provider: "goplus" | "honeypot" | "rugcheck" | "dexscreener";
    ok: boolean;
    detail?: unknown;
  }>;
  completedAt: number;
};

export type Quote = {
  intentId: string;
  address: string;
  chainId: ChainId;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  expectedSlippagePct: number;
  feeEstimateUsd: number;
  route: string;
  completedAt: number;
};

export type StrategyDecision =
  | {
      intentId: string;
      decision: "EXECUTE";
      reason: string;
      approvedAt: number;
    }
  | {
      intentId: string;
      decision: "REJECT";
      reason: string;
      rejectedAt: number;
    }
  | {
      intentId: string;
      decision: "AWAIT_USER_CONFIRM";
      reason: string;
      expiresAt: number;
    };

export type Position = {
  intentId: string;
  positionId: string;
  userId: string;
  address: string;
  chainId: ChainId;
  filled: TradeAmount;
  entryPriceUsd: number;
  txHash: string;
  remainingExits: PartialExit[];
  openedAt: number;
};

export type ExecuteSellPayload = {
  positionId: string;
  fraction: number;
  triggeredBy: ExitTarget;
  emittedAt: number;
};

export type TradeExecutedPayload = Position;

export type PositionUpdate = {
  positionId: string;
  priceUsd: number;
  pnlPct: number;
  at: number;
};

export type AlphaFoundPayload = {
  address: string;
  chainId: ChainId;
  safetyScore: number;
  liquidityUsd: number;
  reason: string;
  foundAt: number;
};

export type IntentCategory =
  | "DEGEN_SNIPE"
  | "TRADE"
  | "RESEARCH_TOKEN"
  | "RESEARCH_WALLET"
  | "COPY_TRADE"
  | "BRIDGE"
  | "PORTFOLIO"
  | "SETTINGS"
  | "GENERAL_QUERY"
  | "UNKNOWN";

export type ResearchRequest = {
  requestId: string;
  userId: string;
  channel: MessageChannel;
  address: string | null;
  tokenName: string | null;
  chain: ChainClass | null;
  question: string;
  rawText: string;
  createdAt: number;
};

export type ResearchResult = {
  requestId: string;
  address: string;
  chain: ChainClass;
  summary: string;
  safetyScore: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  flags: SafetyFlag[];
  completedAt: number;
};

export type GeneralQueryRequest = {
  requestId: string;
  userId: string;
  channel: MessageChannel;
  query: string;
  rawText: string;
  createdAt: number;
};

export type GeneralQueryResult = {
  requestId: string;
  response: string;
  sources: string[];
  completedAt: number;
};

export type BridgeRequest = {
  requestId: string;
  userId: string;
  channel: MessageChannel;
  amount: TradeAmount;
  fromChain: string | null;
  toChain: string;
  asset: string | null;
  rawText: string;
  createdAt: number;
};

export type SettingsUpdate = {
  userId: string;
  setting: string;
  value: string;
  updatedAt: number;
};

export type PortfolioRequest = {
  requestId: string;
  userId: string;
  channel: MessageChannel;
  query: string;
  rawText: string;
  createdAt: number;
};

export type PortfolioResult = {
  requestId: string;
  positions: Position[];
  totalValueUsd: number;
  totalPnlPct: number;
  completedAt: number;
};

export type UserSettings = {
  userId: string;
  mode: TradingMode;
  defaultAmount: TradeAmount;
  defaultExits: PartialExit[];
  wallet: {
    evm?: string;
    solana?: string;
  };
  minSafetyScore: number;
};

export type QuoteFailedPayload = {
  intentId: string;
  address: string;
  reason: string;
};

export type WatchedWallet = {
  address: string;
  label?: string;
  chain?: ChainClass;
};

export const EVENT_NAMES = {
  TRADE_REQUEST: "TRADE_REQUEST",
  SAFETY_RESULT: "SAFETY_RESULT",
  QUOTE_RESULT: "QUOTE_RESULT",
  STRATEGY_DECISION: "STRATEGY_DECISION",
  EXECUTE_TRADE: "EXECUTE_TRADE",
  TRADE_EXECUTED: "TRADE_EXECUTED",
  EXECUTE_SELL: "EXECUTE_SELL",
  ALPHA_FOUND: "ALPHA_FOUND",
  COPY_TRADE_REQUEST: "COPY_TRADE_REQUEST",
  POSITION_UPDATE: "POSITION_UPDATE",
  RESEARCH_REQUEST: "RESEARCH_REQUEST",
  RESEARCH_RESULT: "RESEARCH_RESULT",
  GENERAL_QUERY_REQUEST: "GENERAL_QUERY_REQUEST",
  GENERAL_QUERY_RESULT: "GENERAL_QUERY_RESULT",
  QUOTE_FAILED: "QUOTE_FAILED",
  ADD_WATCHED_WALLET: "ADD_WATCHED_WALLET",
  REMOVE_WATCHED_WALLET: "REMOVE_WATCHED_WALLET",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

export type LlmClient = {
  infer(req: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string }>;
};

export type BusEvents = {
  TRADE_REQUEST: TradeIntent;
  SAFETY_RESULT: SafetyReport;
  QUOTE_RESULT: Quote;
  STRATEGY_DECISION: StrategyDecision;
  EXECUTE_TRADE: Position;
  TRADE_EXECUTED: TradeExecutedPayload;
  EXECUTE_SELL: ExecuteSellPayload;
  ALPHA_FOUND: AlphaFoundPayload;
  COPY_TRADE_REQUEST: TradeIntent;
  POSITION_UPDATE: PositionUpdate;
  RESEARCH_REQUEST: ResearchRequest;
  RESEARCH_RESULT: ResearchResult;
  GENERAL_QUERY_REQUEST: GeneralQueryRequest;
  GENERAL_QUERY_RESULT: GeneralQueryResult;
  QUOTE_FAILED: QuoteFailedPayload;
  ADD_WATCHED_WALLET: WatchedWallet;
  REMOVE_WATCHED_WALLET: string;
};
