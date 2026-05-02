// Intent Parser: regex-first, 0G LLM fallback.
// Returns chain as "evm"|"solana" only. Sub-chain resolution is Quote/Safety's job.
import { randomUUID } from "node:crypto";
import type {
  ChainClass,
  MessageChannel,
  TradeAmount,
  TradeIntent,
  TradingMode,
} from "../shared/types";
import type { OgComputeClient } from "../integrations/0g/compute";
import { OgComputeError } from "../integrations/0g/compute";

const EVM_ADDR = /0x[a-fA-F0-9]{40}/;
// Standalone base58 — anchored by whitespace/boundary so URL substrings
// don't false-match. Same rule as the stub.
const SOL_ADDR = /(?:^|\s)([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|\s|[.,!?])/;

// "0.5 eth", "100 usdc", "25 native"
const NATIVE_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(eth|sol|bnb|matic|avax|native)\b/i;
// "100 usdc" / "25 usdt"
const USD_TOKEN_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(usdc|usdt|dai|busd)\b/i;
// "$25" / "$1,500"
const USD_DOLLAR = /\$(\d+(?:,\d{3})*(?:\.\d+)?)\b/;

const URGENCY_FAST = /\b(now|asap|instant|ape|fast|quick)\b/i;
const URGENCY_CAREFUL = /\b(careful|slow|safe|cautious)\b/i;

export type ParseInput = {
  text: string;
  userId: string;
  channel: MessageChannel;
};

export type StubParseInput = ParseInput;

export type ParserDeps = {
  llm?: OgComputeClient;
  llmTimeoutMs?: number;
  log?: (msg: string, err?: unknown) => void;
};

const DEFAULT_LLM_TIMEOUT_MS = 5_000;

export async function parseIntent(
  input: ParseInput,
  deps: ParserDeps = {},
): Promise<TradeIntent | null> {
  const text = input.text.trim();
  if (text.length === 0) return null;

  // Stage 1 — regex.
  const regexHit = regexParse(text);
  if (regexHit !== null) {
    return buildIntent(input, regexHit);
  }

  // Stage 2 — LLM fallback. Only if:
  //  - an LLM client is wired (deps.llm provided);
  //  - the message is non-trivial (avoid wasting inference on "hi" / "ok").
  if (deps.llm === undefined) return null;
  if (!isPlausibleIntent(text)) return null;

  const llmHit = await runLlm(text, deps);
  if (llmHit === null) return null;
  return buildIntent(input, llmHit);
}

type ParsedCore = {
  address: string;
  chain: ChainClass;
  amount: TradeAmount;
  urgency: TradingMode;
};

function regexParse(text: string): ParsedCore | null {
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

  return {
    address,
    chain,
    amount: extractAmount(text),
    urgency: detectUrgency(text),
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

function isPlausibleIntent(text: string): boolean {
  if (text.length < 10) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 4);
  return words.length >= 1;
}

const LLM_SYSTEM_PROMPT = [
  "You are HAWKEYE's intent parser. Extract a single crypto trade intent from the user message.",
  "Return STRICT JSON only (no prose, no markdown, no code fences) matching this schema:",
  '{"address": string, "chain": "evm"|"solana", "amount": {"value": number, "unit": "NATIVE"|"USD"|"TOKEN"}, "urgency": "INSTANT"|"NORMAL"|"CAREFUL"}',
  "If no trade intent is present, return exactly: null",
  "Rules:",
  "- address is the token contract (EVM 0x... or Solana base58). Do not invent one.",
  '- If no explicit amount is given, use {value: 0, unit: "NATIVE"}.',
  "- Urgency: NORMAL unless the user says 'now/ape/fast' (INSTANT) or 'careful/slow/safe' (CAREFUL).",
  "- Never return prose. Never wrap in code fences. Output must parse as JSON or be the literal null.",
].join("\n");

async function runLlm(text: string, deps: ParserDeps): Promise<ParsedCore | null> {
  const client = deps.llm;
  if (client === undefined) return null;
  const log = deps.log ?? ((m, e) => console.warn(`[intent-parser] ${m}`, e));
  const timeoutMs = deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  let raw: string;
  try {
    const resp = await withTimeout(
      client.infer({ system: LLM_SYSTEM_PROMPT, user: text, temperature: 0 }),
      timeoutMs,
    );
    raw = resp.text.trim();
  } catch (err) {
    if (err instanceof OgComputeError && err.reason === "LEDGER_LOW") {
      log("LLM fallback skipped: ledger low", err);
    } else {
      log("LLM fallback failed", err);
    }
    return null;
  }

  if (raw === "" || raw.toLowerCase() === "null") return null;

  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    log(`LLM response was not JSON: ${stripped.slice(0, 120)}`, err);
    return null;
  }
  if (parsed === null) return null;

  return validateLlmIntent(parsed);
}

function stripCodeFences(s: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence && fence[1]) return fence[1];
  return s;
}

function validateLlmIntent(obj: unknown): ParsedCore | null {
  if (obj === null || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const address = typeof o["address"] === "string" ? o["address"].trim() : null;
  if (address === null || address.length === 0) return null;

  const chain = o["chain"];
  if (chain !== "evm" && chain !== "solana") return null;

  // Cross-check: EVM addresses must match the regex; Solana must be base58.
  if (chain === "evm" && !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;

  const amountRaw = o["amount"];
  let amount: TradeAmount = { value: 0, unit: "NATIVE" };
  if (amountRaw !== null && typeof amountRaw === "object") {
    const a = amountRaw as Record<string, unknown>;
    const v = typeof a["value"] === "number" ? a["value"] : 0;
    const u = a["unit"];
    const unit: TradeAmount["unit"] = u === "USD" || u === "TOKEN" || u === "NATIVE" ? u : "NATIVE";
    amount = { value: Number.isFinite(v) && v > 0 ? v : 0, unit };
  }

  const urgency = o["urgency"];
  const mode: TradingMode = urgency === "INSTANT" || urgency === "CAREFUL" ? urgency : "NORMAL";

  return { address, chain, amount, urgency: mode };
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

function buildIntent(input: ParseInput, core: ParsedCore): TradeIntent {
  return {
    intentId: randomUUID(),
    userId: input.userId,
    channel: input.channel,
    address: core.address,
    chain: core.chain,
    amount: core.amount,
    exits: [],
    urgency: core.urgency,
    rawText: input.text,
    createdAt: Date.now(),
  };
}
