import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const FILE_PATH = resolve(DATA_DIR, "seen-tokens.json");

type SeenToken = {
  address: string;
  chainId: string;
  symbol?: string | undefined;
  seenAt: number;
};

type SeenTokenMap = Record<string, SeenToken[]>;

let store: SeenTokenMap = {};

function flush(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch {}
}

export function loadSeenTokens(): void {
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    store = JSON.parse(raw) as SeenTokenMap;
  } catch {}
}

export function trackToken(userId: string, address: string, chainId: string, symbol?: string): void {
  const tokens = store[userId] ?? [];
  const lower = address.toLowerCase();
  const existing = tokens.find((t) => t.address.toLowerCase() === lower && t.chainId === chainId);
  if (existing) {
    if (symbol && !existing.symbol) existing.symbol = symbol;
    existing.seenAt = Date.now();
  } else {
    tokens.push({ address, chainId, symbol, seenAt: Date.now() });
  }
  store[userId] = tokens;
  flush();
}

export function getSeenTokens(userId: string): SeenToken[] {
  return store[userId] ?? [];
}
