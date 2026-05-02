import { randomUUID } from "node:crypto";
import type {
  ChainClass,
  IntentCategory,
  MessageChannel,
  TradeAmount,
  TradingMode,
} from "../shared/types";
import type { OgComputeClient } from "../integrations/0g/compute";
import { OgComputeError } from "../integrations/0g/compute";

const EVM_ADDR = /0x[a-fA-F0-9]{40}/;
const SOL_ADDR = /(?:^|\s)([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|\s|[.,!?])/;

const NATIVE_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(?:\w+\s+)?(eth|sol|bnb|matic|avax|native)\b/i;
const USD_TOKEN_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(usdc|usdt|dai|busd)\b/i;
const USD_DOLLAR = /\$(\d+(?:,\d{3})*(?:\.\d+)?)\b/;

const URGENCY_FAST = /\b(now|asap|instant|ape|fast|quick)\b/i;
const URGENCY_CAREFUL = /\b(careful|slow|safe|cautious)\b/i;

const DEGEN_KEYWORDS =
  /\b(ape|buy|send\s*it|yolo|snipe|get|grab|long|pump|moon|degen|letsgo|go|in|sell|dump|exit|close|short)\b/i;
const SELL_KEYWORDS = /\b(sell|dump|exit|close|short)\b/i;

export type RouterInput = {
  text: string;
  userId: string;
  channel: MessageChannel;
};

export type RouterResult = {
  id: string;
  category: IntentCategory;
  confidence: number;
  data: Record<string, unknown>;
  rawText: string;
  userId: string;
  channel: MessageChannel;
  routedAt: number;
};

export type RouterDeps = {
  llm?: OgComputeClient;
  llmTimeoutMs?: number;
  log?: (msg: string, err?: unknown) => void;
};

const DEFAULT_LLM_TIMEOUT_MS = 15_000;

export async function routeMessage(
  input: RouterInput,
  deps: RouterDeps = {},
): Promise<RouterResult> {
  const text = input.text.trim();
  if (text.length === 0) {
    return buildResult(input, "UNKNOWN", 1.0, { rawIntent: "" });
  }

  const snipe = tryDegenShortcut(text);
  if (snipe !== null) {
    return buildResult(input, "DEGEN_SNIPE", 1.0, snipe);
  }

  if (deps.llm === undefined) {
    return regexFallback(input);
  }

  return routeViaLlm(input, deps);
}

type SnipeData = {
  address: string;
  chain: ChainClass;
  amount: TradeAmount;
  urgency: TradingMode;
  side: "buy" | "sell";
};

function tryDegenShortcut(text: string): SnipeData | null {
  const evm = text.match(EVM_ADDR);
  const sol = text.match(SOL_ADDR);

  let address: string | null = null;
  let chain: ChainClass | null = null;
  if (evm && evm[0]) {
    address = evm[0];
    chain = "evm";
  } else if (sol && sol[1]) {
    address = sol[1];
    chain = "solana";
  }
  if (address === null || chain === null) return null;

  const remainder = text
    .replace(address, "")
    .replace(DEGEN_KEYWORDS, "")
    .replace(NATIVE_AMOUNT, "")
    .replace(USD_TOKEN_AMOUNT, "")
    .replace(USD_DOLLAR, "")
    .replace(URGENCY_FAST, "")
    .replace(URGENCY_CAREFUL, "")
    .replace(/[.,!?@#$%^&*()]/g, "")
    .trim();

  // Send/transfer with an address is not a snipe — let LLM or regex classify as SEND_TOKEN
  if (SEND_KW.test(text)) return null;

  // If meaningful words remain, this isn't a bare degen snipe — let LLM classify
  if (remainder.length > 15) return null;

  const isSell = SELL_KEYWORDS.test(text);
  return {
    address,
    chain,
    amount: extractAmount(text),
    urgency: detectUrgency(text) === "NORMAL" ? "INSTANT" : detectUrgency(text),
    side: isSell ? "sell" : "buy",
  };
}

function extractAmount(text: string): TradeAmount {
  const dollar = text.match(USD_DOLLAR);
  if (dollar && dollar[1]) {
    const v = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "USD" };
  }
  const usd = text.match(USD_TOKEN_AMOUNT);
  if (usd && usd[1]) {
    const v = Number(usd[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "USD" };
  }
  const native = text.match(NATIVE_AMOUNT);
  if (native && native[1]) {
    const v = Number(native[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "NATIVE" };
  }
  return { value: 0, unit: "NATIVE" };
}

function detectUrgency(text: string): TradingMode {
  if (URGENCY_FAST.test(text)) return "INSTANT";
  if (URGENCY_CAREFUL.test(text)) return "CAREFUL";
  return "NORMAL";
}

const CHAIN_HINTS: Record<string, string> = {
  sepolia: "sepolia", ethereum: "ethereum", eth: "ethereum",
  base: "base", arbitrum: "arbitrum", arb: "arbitrum",
  optimism: "optimism", op: "optimism", polygon: "polygon",
  matic: "polygon", bsc: "bsc", bnb: "bsc", avalanche: "avalanche",
  avax: "avalanche",
};

function extractChainHint(lower: string): string | null {
  for (const [kw, chain] of Object.entries(CHAIN_HINTS)) {
    if (lower.includes(kw)) return chain;
  }
  return null;
}

const ROUTER_SYSTEM_PROMPT = [
  "You are HAWKEYE, an autonomous crypto trading agent. You can execute on-chain actions: buy, sell, swap, send, bridge, and check balances. Classify what the user wants and return structured JSON.",
  "",
  "Return ONLY valid JSON. No prose, no markdown, no code fences.",
  "",
  "Categories:",
  "",
  "DEGEN_SNIPE — Bare contract address pasted with minimal or no text, implying buy.",
  "TRADE — Any buy, sell, or swap. \"buy 0.5 ETH of PEPE\", \"sell my LINK\", \"swap ETH to USDC\", \"sell this 0xABC\".",
  "SEND_TOKEN — User wants to SEND or TRANSFER tokens to another wallet. \"send 0.01 ETH to 0xABC\", \"transfer 5 MATIC to 0xDEF on polygon\". The 0x address is a RECIPIENT, not a token.",
  "RESEARCH_TOKEN — Info about a token, trending tokens, alpha. \"is this safe?\", \"what's trending on base?\", \"any alpha?\", \"what's hot?\".",
  "RESEARCH_WALLET — Info about a wallet's activity. \"what's 0xABC buying?\", \"track this wallet\".",
  "COPY_TRADE — Follow or mirror a wallet's trades. \"copy this wallet\", \"mirror 0xABC\".",
  "BRIDGE — Move assets across chains. \"bridge 0.5 ETH to Base\", \"move my USDC to Arbitrum\".",
  "PORTFOLIO — Check balances, positions, PnL, holdings. \"what is my balance\", \"my sepolia ETH balance\", \"show my bags\", \"how are my positions\", \"check balance on base\".",
  "SETTINGS — Change bot config. \"set degen mode\", \"default amount 1 SOL\".",
  "GENERAL_QUERY — Greetings, general crypto questions, anything that is NOT an on-chain action or data lookup.",
  "UNKNOWN — Cannot classify.",
  "",
  "Key distinctions:",
  "- \"send 0.01 ETH to 0xABC\" = SEND_TOKEN (transferring to a recipient). \"buy 0xABC\" = DEGEN_SNIPE (buying a token at that contract).",
  "- \"bridge ETH to Base\" = BRIDGE. \"swap ETH to USDC\" = TRADE. Different actions.",
  "- Any mention of \"balance\", \"my wallet\", \"my holdings\", \"positions\", \"PnL\" = PORTFOLIO. Never GENERAL_QUERY.",
  "- \"what's trending\", \"what's hot\", \"top movers\", \"any alpha\" = RESEARCH_TOKEN.",
  "- A bare 0x address with no other context = DEGEN_SNIPE.",
  "- A 0x address + \"send\"/\"transfer\" = SEND_TOKEN.",
  "- A 0x address + \"safe?\"/\"check\"/\"research\" = RESEARCH_TOKEN.",
  "",
  "Response: { \"category\": \"...\", \"confidence\": 0.0-1.0, \"data\": { ... } }",
  "",
  "Data per category:",
  "DEGEN_SNIPE: { address, chain: \"evm\"|\"solana\", amount: {value,unit}|null, urgency: \"INSTANT\"|\"NORMAL\"|\"CAREFUL\" }",
  "TRADE: { address|null, fromToken|null, toToken|null, chain|null, side: \"buy\"|\"sell\"|\"swap\", amount: {value,unit}|null, urgency }",
  "SEND_TOKEN: { recipient: \"0x...\", amount: {value, unit}, chain|null, asset|null }",
  "RESEARCH_TOKEN: { address|null, tokenName|null, chain|null, question: string, subIntent: \"TOKEN_LOOKUP\"|\"WHALE_ANALYSIS\"|\"TRENDING\"|\"MARKET_OVERVIEW\"|\"CATEGORY\"|\"SAFETY_CHECK\"|\"PRICE_ACTION\", tools: string[] }",
  "RESEARCH_WALLET: { walletAddress, chain, question }",
  "COPY_TRADE: { walletAddress, chain, autoTrade: boolean }",
  "BRIDGE: { amount: {value,unit}, fromChain|null, toChain, asset|null }",
  "PORTFOLIO: { query, chain|null }",
  "SETTINGS: { setting, value }",
  "GENERAL_QUERY: { query }",
  "UNKNOWN: { rawIntent }",
  "",
  "RESEARCH_TOKEN sub-intents and default tools:",
  "TOKEN_LOOKUP: user wants a full breakdown of a specific token. tools: [\"dexscreener\",\"goplus\",\"coingecko\",\"etherscan\"]",
  "WHALE_ANALYSIS: user asks about holders, whales, smart money, \"who's buying\". tools: [\"arkham\",\"etherscan\",\"nansen\",\"dexscreener\"]",
  "TRENDING: user asks what's hot, trending, pumping, new listings, alpha. tools: [\"dexscreener\",\"coingecko\",\"arkham_trending\"]",
  "MARKET_OVERVIEW: user asks about the market, BTC/ETH, sentiment, fear & greed. tools: [\"coingecko\",\"feargreed\"]",
  "CATEGORY: user asks about a category (memecoins, defi, gaming) on a chain. tools: [\"coingecko\",\"dexscreener\"]",
  "SAFETY_CHECK: user specifically asks \"is this safe\", \"check this contract\", \"rug?\". tools: [\"goplus\",\"honeypot\",\"etherscan\",\"dexscreener\"]",
  "PRICE_ACTION: user asks about price movement, chart, momentum, candles. tools: [\"dexscreener\",\"coingecko\",\"geckoterminal\"]",
  "",
  "RESEARCH_TOKEN examples:",
  "\"what's trending on base\" -> subIntent=TRENDING, tools=[\"dexscreener\",\"coingecko\",\"arkham_trending\"]",
  "\"is 0xABC safe\" -> subIntent=SAFETY_CHECK, tools=[\"goplus\",\"honeypot\",\"etherscan\",\"dexscreener\"]",
  "\"who holds the most PEPE\" -> subIntent=WHALE_ANALYSIS, tools=[\"arkham\",\"etherscan\",\"dexscreener\"]",
  "\"what's the market doing\" -> subIntent=MARKET_OVERVIEW, tools=[\"coingecko\",\"feargreed\"]",
  "\"how's ETH doing\" -> subIntent=PRICE_ACTION, tools=[\"dexscreener\",\"coingecko\",\"geckoterminal\"]",
  "\"show me memecoins on base\" -> subIntent=CATEGORY, tools=[\"coingecko\",\"dexscreener\"]",
  "\"tell me about LINK\" -> subIntent=TOKEN_LOOKUP, tools=[\"dexscreener\",\"goplus\",\"coingecko\",\"etherscan\"]",
  "\"check 0x6982...\" -> subIntent=TOKEN_LOOKUP, tools=[\"dexscreener\",\"goplus\",\"coingecko\",\"etherscan\"]",
  "",
  "Address format: EVM = 0x + 40 hex. Solana = 32-44 base58. Never invent addresses.",
  "Extract chain names (sepolia, base, arbitrum, polygon, bsc, optimism, avalanche, ethereum) into chain field.",
  "Extract token symbols (ETH, USDC, PEPE) into fromToken/toToken/asset.",
  "DEGEN_SNIPE default urgency = INSTANT. Others = NORMAL.",
].join("\n");

async function routeViaLlm(input: RouterInput, deps: RouterDeps): Promise<RouterResult> {
  const client = deps.llm;
  if (client === undefined) return regexFallback(input);

  const log = deps.log ?? ((m: string) => console.warn(`[llm-router] ${m}`));
  const timeoutMs = deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  let raw: string;
  try {
    const resp = await withTimeout(
      client.infer({
        system: ROUTER_SYSTEM_PROMPT,
        user: input.text,
        temperature: 0,
      }),
      timeoutMs,
    );
    raw = resp.text.trim();
  } catch (err) {
    if (err instanceof OgComputeError && err.reason === "LEDGER_LOW") {
      log("LLM router skipped: ledger low");
    } else {
      log("LLM router failed");
    }
    return regexFallback(input);
  }

  if (raw === "" || raw.toLowerCase() === "null") {
    return buildResult(input, "UNKNOWN", 0, { rawIntent: input.text });
  }

  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    log(`LLM response was not JSON: ${stripped.slice(0, 120)}`);
    return buildResult(input, "UNKNOWN", 0, { rawIntent: input.text });
  }

  if (parsed === null || typeof parsed !== "object") {
    return buildResult(input, "UNKNOWN", 0, { rawIntent: input.text });
  }

  const obj = parsed as Record<string, unknown>;
  const category = validateCategory(obj["category"]);
  const confidence = typeof obj["confidence"] === "number" ? obj["confidence"] : 0.5;
  const data =
    obj["data"] !== null && typeof obj["data"] === "object"
      ? (obj["data"] as Record<string, unknown>)
      : { rawIntent: input.text };

  const lower = input.text.toLowerCase();

  // Correct obvious misclassifications before returning
  if ((category === "DEGEN_SNIPE" || category === "TRADE" || category === "GENERAL_QUERY") && SEND_KW.test(lower)) {
    const evm = input.text.match(EVM_ADDR);
    if (evm) {
      return buildResult(input, "SEND_TOKEN", 0.9, {
        recipient: evm[0],
        amount: extractAmount(input.text),
        chain: extractChainHint(lower),
      });
    }
  }

  if ((category === "GENERAL_QUERY" || category === "UNKNOWN") && PORTFOLIO_KW.test(lower)) {
    return buildResult(input, "PORTFOLIO", 0.8, { query: input.text });
  }

  if (category === "DEGEN_SNIPE" || category === "TRADE") {
    const validated = validateTradeData(data);
    if (validated !== null) {
      return buildResult(input, category, confidence, validated);
    }
  }

  if (confidence < 0.3) {
    return buildResult(input, "UNKNOWN", confidence, { rawIntent: input.text });
  }

  return buildResult(input, category, confidence, data);
}

function validateCategory(raw: unknown): IntentCategory {
  const valid: IntentCategory[] = [
    "DEGEN_SNIPE",
    "TRADE",
    "SEND_TOKEN",
    "RESEARCH_TOKEN",
    "RESEARCH_WALLET",
    "COPY_TRADE",
    "BRIDGE",
    "PORTFOLIO",
    "SETTINGS",
    "GENERAL_QUERY",
    "UNKNOWN",
  ];
  if (typeof raw === "string" && valid.includes(raw as IntentCategory)) {
    return raw as IntentCategory;
  }
  return "UNKNOWN";
}

function validateTradeData(data: Record<string, unknown>): SnipeData | null {
  const address = typeof data["address"] === "string" ? data["address"].trim() : null;
  if (address === null || address.length === 0) return null;

  const chain = data["chain"];
  if (chain !== "evm" && chain !== "solana") return null;

  if (chain === "evm" && !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;

  let amount: TradeAmount = { value: 0, unit: "NATIVE" };
  const amountRaw = data["amount"];
  if (amountRaw !== null && typeof amountRaw === "object") {
    const a = amountRaw as Record<string, unknown>;
    const v = typeof a["value"] === "number" ? a["value"] : 0;
    const u = a["unit"];
    const unit: TradeAmount["unit"] = u === "USD" || u === "TOKEN" || u === "NATIVE" ? u : "NATIVE";
    amount = { value: Number.isFinite(v) && v > 0 ? v : 0, unit };
  }

  const urgency = data["urgency"];
  const mode: TradingMode = urgency === "INSTANT" || urgency === "CAREFUL" ? urgency : "NORMAL";

  return { address, chain, amount, urgency: mode, side: "buy" };
}

const SWAP_KW = /\b(swap|exchange|convert|trade)\b/i;
const SEND_KW = /\b(send|transfer)\b/i;
const BRIDGE_KW = /\b(bridge|transfer|move|send)\s.*(to|from|across)\s/i;
const LP_KW = /\b(liquidity|lp|provide|pool|add liquidity|remove liquidity)\b/i;
const PORTFOLIO_KW = /\b(portfolio|positions|bags|holdings|balance|pnl|my wallet)\b/i;
const RESEARCH_KW = /\b(safe|rug|scam|check|research|analyze|audit|info|details|honeypot)\b/i;
const SETTINGS_KW = /\b(settings?|set|config|default|mode|slippage)\b/i;
const TRENDING_KW = /\b(trending|alpha|hot|what.?s new|movers|gainers|top)\b/i;

function regexFallback(input: RouterInput): RouterResult {
  const text = input.text.trim();
  const lower = text.toLowerCase();

  const evm = text.match(EVM_ADDR);
  const sol = text.match(SOL_ADDR);

  if (evm || sol) {
    const address = evm ? evm[0]! : sol![1]!;
    const chain: ChainClass = evm ? "evm" : "solana";

    if (RESEARCH_KW.test(lower)) {
      return buildResult(input, "RESEARCH_TOKEN", 0.7, {
        address,
        chain,
        question: text,
      });
    }

    if (SEND_KW.test(lower)) {
      return buildResult(input, "SEND_TOKEN", 0.8, {
        recipient: address,
        amount: extractAmount(text),
        chain: extractChainHint(lower),
      });
    }

    const isSell = SELL_KEYWORDS.test(lower);
    return buildResult(input, "DEGEN_SNIPE", 0.6, {
      address,
      chain,
      amount: extractAmount(text),
      urgency: detectUrgency(text) === "NORMAL" ? "INSTANT" : detectUrgency(text),
      side: isSell ? "sell" : "buy",
    });
  }

  if (SWAP_KW.test(lower)) {
    const isSell = SELL_KEYWORDS.test(lower);
    return buildResult(input, "TRADE", 0.7, {
      query: text,
      side: isSell ? "sell" : "buy",
    });
  }

  if (BRIDGE_KW.test(lower)) {
    return buildResult(input, "BRIDGE", 0.7, { query: text });
  }

  if (LP_KW.test(lower)) {
    return buildResult(input, "TRADE", 0.6, { query: text, side: "lp" });
  }

  if (PORTFOLIO_KW.test(lower)) {
    return buildResult(input, "PORTFOLIO", 0.7, { query: text });
  }

  if (SETTINGS_KW.test(lower)) {
    return buildResult(input, "SETTINGS", 0.6, { setting: text, value: "" });
  }

  if (TRENDING_KW.test(lower)) {
    return buildResult(input, "GENERAL_QUERY", 0.7, { query: text });
  }

  return buildResult(input, "GENERAL_QUERY", 0.5, { query: text });
}

function stripCodeFences(s: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence && fence[1]) return fence[1];
  return s;
}

function buildResult(
  input: RouterInput,
  category: IntentCategory,
  confidence: number,
  data: Record<string, unknown>,
): RouterResult {
  return {
    id: randomUUID(),
    category,
    confidence,
    data,
    rawText: input.text,
    userId: input.userId,
    channel: input.channel,
    routedAt: Date.now(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err as Error);
      },
    );
  });
}
