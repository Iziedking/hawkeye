/**
  Smoke test: Monitor Agent + Copy Trade Agent
  
 npx tsx src/agents/monitor/smoke-test.ts
 */

import bus from "../../shared/event-bus";
import {
  startMonitorAgent,
  getActiveWatcherCount,
} from "./index";
import {
  startCopyTradeAgent,
  getWatchedWalletCount,
  getWatchedWalletAddresses,
  addWatchedWallet,
  removeWatchedWallet,
  setCopyTradeFilters,
  getPendingCopyCount,
} from "../copy-trade/index";
import type {
  Position,
  ExecuteSellPayload,
  TradeIntent,
  PartialExit,
  TradeAmount,
} from "../../shared/types";

// Harness

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Mock DexScreener
let mockPriceUsd = 0;
let mockFdvUsd: number | null = null;

(globalThis as Record<string, unknown>)["__mcp_dexscreener"] = {
  search_pairs: async ({ query }: { query: string }) => ({
    pairs: [{
      chainId: "ethereum",
      priceUsd: String(mockPriceUsd),
      fdv: mockFdvUsd !== null ? String(mockFdvUsd) : null,
      marketCap: null,
      baseToken: { address: query, symbol: "MOCK" },
      quoteToken: { address: "0xusdc", symbol: "USDC" },
    }],
  }),
};

// Position factory

function makePosition(id: string, entryPrice: number, exits: PartialExit[]): Position {
  const filled: TradeAmount = { value: 0.5, unit: "NATIVE" };
  return {
    intentId: "intent-001",
    positionId: id,
    userId: "user-001",
    address: "0xtoken",
    chainId: "ethereum",
    filled,
    entryPriceUsd: entryPrice,
    txHash: "0xtx001",
    remainingExits: exits,
    openedAt: Date.now(),
  };
}

// Monitor tests 

async function testMultiplierExit(): Promise<void> {
  console.log("\n[Test 1] Multiplier exit (2x)");
  const position = makePosition("pos-2x-001", 100, [
    { percent: 100, target: { kind: "multiplier", value: 2 } },
  ]);
  let received: ExecuteSellPayload | null = null;
  bus.once("EXECUTE_SELL", (p: ExecuteSellPayload) => {
    if (p.positionId === "pos-2x-001") received = p;
  });
  mockPriceUsd = 150;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);
  assert(getActiveWatcherCount() >= 1, "Watcher spawned");
  mockPriceUsd = 210;
  await wait(6_000);
  assert(received !== null, "EXECUTE_SELL emitted on 2x hit");
  if (received !== null) {
    const r = received as ExecuteSellPayload;
    assert(r.triggeredBy.kind === "multiplier", "triggeredBy.kind === 'multiplier'");
    assert(r.fraction === 1, "fraction === 1");
  }
}

async function testPriceExit(): Promise<void> {
  console.log("\n[Test 2] Price exit ($3500)");
  const position = makePosition("pos-price-002", 3000, [
    { percent: 50, target: { kind: "price", usd: 3500 } },
  ]);
  let received: ExecuteSellPayload | null = null;
  bus.once("EXECUTE_SELL", (p: ExecuteSellPayload) => {
    if (p.positionId === "pos-price-002") received = p;
  });
  mockPriceUsd = 3200;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);
  mockPriceUsd = 3600;
  await wait(6_000);
  assert(received !== null, "EXECUTE_SELL emitted on price hit");
  if (received !== null) {
    const r = received as ExecuteSellPayload;
    assert(r.triggeredBy.kind === "price", "triggeredBy.kind === 'price'");
    assert(r.fraction === 0.5, "fraction === 0.5");
  }
}

async function testPartialExitSequence(): Promise<void> {
  console.log("\n[Test 3] Partial exit sequence");
  const position = makePosition("pos-partial-003", 100, [
    { percent: 50, target: { kind: "multiplier", value: 2 } },
    { percent: 50, target: { kind: "multiplier", value: 5 } },
  ]);
  const received: ExecuteSellPayload[] = [];
  const handler = (p: ExecuteSellPayload): void => {
    if (p.positionId === "pos-partial-003") received.push(p);
  };
  bus.on("EXECUTE_SELL", handler);
  mockPriceUsd = 150;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);
  mockPriceUsd = 210;
  await wait(6_000);
  assert(received.length === 1, "First exit at 2x");
  const first = received[0];
  if (first !== undefined) assert(first.fraction === 0.5, "First fraction === 0.5");
  assert(getActiveWatcherCount() >= 1, "Watcher alive for second exit");
  mockPriceUsd = 510;
  await wait(6_000);
  assert(received.length === 2, "Second exit at 5x");
  const second = received[1];
  if (second !== undefined) assert(second.fraction === 0.5, "Second fraction === 0.5");
  bus.off("EXECUTE_SELL", handler);
}

async function testTrailingStop(): Promise<void> {
  console.log("\n[Test 4] Trailing stop loss (20% below peak)");
  const position = makePosition("pos-trail-004", 100, [
    { percent: 100, target: { kind: "price", usd: 9999 } },
  ]);
  let received: ExecuteSellPayload | null = null;
  const handler = (p: ExecuteSellPayload): void => {
    if (p.positionId === "pos-trail-004") received = p;
  };
  bus.on("EXECUTE_SELL", handler);
  mockPriceUsd = 100;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);
  mockPriceUsd = 200; // peak = 200
  await wait(6_000);
  mockPriceUsd = 155; // 22.5% below peak — trailing stop at 20% should fire
  await wait(6_000);
  assert(received !== null, "EXECUTE_SELL emitted on trailing stop");
  if (received !== null) {
    const r = received as ExecuteSellPayload;
    assert(r.fraction === 1, "Full exit on trailing stop");
  }
  bus.off("EXECUTE_SELL", handler);
}

async function testDuplicateGuard(): Promise<void> {
  console.log("\n[Test 5] Duplicate TRADE_EXECUTED guard");
  mockPriceUsd = 50;
  const countBefore = getActiveWatcherCount();
  const position = makePosition("pos-dup-005", 50, [
    { percent: 100, target: { kind: "price", usd: 9999 } },
  ]);
  bus.emit("TRADE_EXECUTED", position);
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);
  assert(getActiveWatcherCount() === countBefore + 1, "Only one watcher spawned");
  bus.emit("EXECUTE_SELL", {
    positionId: "pos-dup-005",
    fraction: 1,
    triggeredBy: { kind: "price", usd: 9999 },
    emittedAt: Date.now(),
  } satisfies ExecuteSellPayload);
  await wait(100);
}

// Copy Trade tests 

async function testCopyTradeEmitsTrade(): Promise<void> {
  console.log("\n[Test 6] COPY_TRADE_REQUEST → TRADE_REQUEST");
  let received: TradeIntent | null = null;
  bus.once("TRADE_REQUEST", (intent: TradeIntent) => { received = intent; });
  const mockIntent: TradeIntent = {
    intentId: "copy-001",
    userId: "copy-trade:0xabc123",
    channel: "webchat",
    address: "0xtoken456",
    chain: "evm",
    chainHint: "ethereum",
    amount: { value: 500, unit: "USD" },
    exits: [],
    urgency: "NORMAL",
    rawText: "copy trade 0xtoken456",
    createdAt: Date.now(),
  };
  bus.emit("COPY_TRADE_REQUEST", mockIntent);
  await wait(300);
  assert(received !== null, "TRADE_REQUEST emitted");
  if (received !== null) {
    const r = received as TradeIntent;
    assert(r.address === "0xtoken456", "token address preserved");
    assert(r.rawText.startsWith("[Copy]"), "rawText prefixed with [Copy]");
  }
}

async function testMinTradeSizeFilter(): Promise<void> {
  console.log("\n[Test 7] Min trade size filter");
  setCopyTradeFilters({ minTradeSizeUsd: 1000 });
  let received: TradeIntent | null = null;
  bus.once("TRADE_REQUEST", (i: TradeIntent) => { received = i; });
  const small: TradeIntent = {
    intentId: "copy-small-001",
    userId: "copy-trade:0xabc",
    channel: "webchat",
    address: "0xtoken",
    chain: "evm",
    chainHint: "ethereum",
    amount: { value: 50, unit: "USD" },
    exits: [],
    urgency: "NORMAL",
    rawText: "small trade",
    createdAt: Date.now(),
  };
  bus.emit("COPY_TRADE_REQUEST", small);
  await wait(300);
  assert(received === null, "TRADE_REQUEST blocked for small trade");
  setCopyTradeFilters({ minTradeSizeUsd: 100 });
}

async function testBlacklist(): Promise<void> {
  console.log("\n[Test 8] Token blacklist");
  const blockedToken = "0xbadtoken";
  setCopyTradeFilters({ tokenBlacklist: new Set([blockedToken]) });
  let received: TradeIntent | null = null;
  bus.once("TRADE_REQUEST", (i: TradeIntent) => { received = i; });
  const blacklisted: TradeIntent = {
    intentId: "copy-black-001",
    userId: "copy-trade:0xabc",
    channel: "webchat",
    address: blockedToken,
    chain: "evm",
    chainHint: "ethereum",
    amount: { value: 500, unit: "USD" },
    exits: [],
    urgency: "NORMAL",
    rawText: "blacklisted token",
    createdAt: Date.now(),
  };
  bus.emit("COPY_TRADE_REQUEST", blacklisted);
  await wait(300);
  assert(received === null, "TRADE_REQUEST blocked for blacklisted token");
  setCopyTradeFilters({ tokenBlacklist: new Set() });
}

async function testDelayedCopy(): Promise<void> {
  console.log("\n[Test 9] Delayed copy trade (500ms)");
  setCopyTradeFilters({ delayMs: 500 });
  let received: TradeIntent | null = null;
  bus.once("TRADE_REQUEST", (i: TradeIntent) => { received = i; });
  const intent: TradeIntent = {
    intentId: "copy-delay-001",
    userId: "copy-trade:0xabc",
    channel: "webchat",
    address: "0xdelaytoken",
    chain: "evm",
    chainHint: "ethereum",
    amount: { value: 500, unit: "USD" },
    exits: [],
    urgency: "NORMAL",
    rawText: "delayed trade",
    createdAt: Date.now(),
  };
  bus.emit("COPY_TRADE_REQUEST", intent);
  await wait(100);
  assert(received === null, "Not emitted immediately");
  assert(getPendingCopyCount() >= 1, "Copy is pending");
  await wait(600);
  assert(received !== null, "Emitted after delay");
  setCopyTradeFilters({ delayMs: 0 });
}

async function testWalletManagement(): Promise<void> {
  console.log("\n[Test 10] Wallet add / remove");
  const countBefore = getWatchedWalletCount();
  const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  addWatchedWallet({ address: addr, label: "test", chain: "evm", chainId: "ethereum" });
  await wait(100);
  assert(getWatchedWalletCount() === countBefore + 1, "Wallet added");
  assert(getWatchedWalletAddresses().includes(addr.toLowerCase()), "Address tracked");
  removeWatchedWallet(addr);
  await wait(100);
  assert(getWatchedWalletCount() === countBefore, "Wallet removed");
}

// Run
async function runAll(): Promise<void> {
  console.log("=== Hawkeye Monitor + CopyTrade Smoke Tests ===");

  const monitor = startMonitorAgent();
  const copyTrade = startCopyTradeAgent();

  await testMultiplierExit();
  await testPriceExit();
  await testPartialExitSequence();
  await testTrailingStop();
  await testDuplicateGuard();
  await testCopyTradeEmitsTrade();
  await testMinTradeSizeFilter();
  await testBlacklist();
  await testDelayedCopy();
  await testWalletManagement();

  monitor.stop();
  copyTrade.stop();

  console.log(`\n=== ${passed} passed  ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void runAll();