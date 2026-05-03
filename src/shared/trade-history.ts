import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const FILE_PATH = resolve(DATA_DIR, "trade-history.json");

export type TradeRecord = {
  intentId: string;
  userId: string;
  side: "buy" | "sell";
  address: string;
  chainId: string;
  symbol?: string | undefined;
  filled: { value: number; unit: string };
  priceUsd: number;
  txHash: string;
  mevProtected?: boolean | undefined;
  timestamp: number;
};

type HistoryMap = Record<string, TradeRecord[]>;

let store: HistoryMap = {};

function flush(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch {}
}

export function loadTradeHistory(): void {
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    store = JSON.parse(raw) as HistoryMap;
  } catch {}
}

export function recordTrade(record: TradeRecord): void {
  const trades = store[record.userId] ?? [];
  trades.push(record);
  store[record.userId] = trades;
  flush();
}

export function getTradeHistory(userId: string, limit = 20): TradeRecord[] {
  const trades = store[userId] ?? [];
  return trades.slice(-limit);
}

export function getTradeCount(userId: string): number {
  return (store[userId] ?? []).length;
}
