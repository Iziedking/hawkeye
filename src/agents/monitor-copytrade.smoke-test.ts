/**
 Smoke test: Monitor Agent + Copy Trade Agent
 */

import bus from "../shared/event-bus";
import {
  startMonitorAgent,
  getActiveWatcherCount,
} from "./monitor";
import {
  startCopyTradeAgent,
  getWatchedWalletCount,
  getWatchedWalletAddresses,
  addWalletDirectly,
} from "./copytrade";
import type {
  Position,
  ExecuteSellPayload,
  TradeIntent,
  PartialExit,
  TradeAmount,
} from "../shared/types";

// Test harness

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Mock DexScreener MCP ─────────────────────────────────────────────────────

let mockPriceUsd = 0;

(globalThis as Record<string, unknown>)["__mcp_dexscreener"] = {
  search_pairs: async ({ query }: { query: string }) => ({
    pairs: [
      {
        chainId: "ethereum",
        priceUsd: String(mockPriceUsd),
        baseToken: { address: query, symbol: "MOCK" },
        quoteToken: { address: "0xusdc", symbol: "USDC" },
      },
    ],
  }),
};

//  Position factory 

function makePosition(
  positionId: string,
  entryPriceUsd: number,
  exits: PartialExit[],
): Position {
  const filled: TradeAmount = { value: 0.5, unit: "NATIVE" };
  return {
    intentId: "intent-001",
    positionId,
    userId: "user-001",
    address: "0xtoken",
    chainId: "ethereum",
    filled,
    entryPriceUsd,
    txHash: "0xtx001",
    remainingExits: exits,
    openedAt: Date.now(),
  };
}

//  Tests 

async function testMultiplierExitTrigger(): Promise<void> {
  console.log("\n[Test 1] Multiplier exit (2x) fires EXECUTE_SELL");

  const exits: PartialExit[] = [
    { percent: 100, target: { kind: "multiplier", value: 2 } },
  ];
  const position = makePosition("pos-2x-001", 100, exits);

  let received: ExecuteSellPayload | null = null;
  const handler = (p: ExecuteSellPayload): void => {
    if (p.positionId === "pos-2x-001") received = p;
  };
  bus.once("EXECUTE_SELL", handler);

  mockPriceUsd = 150;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);

  assert(getActiveWatcherCount() >= 1, "Watcher spawned after TRADE_EXECUTED");

  mockPriceUsd = 210;
  await wait(6_000);

  assert(received !== null, "EXECUTE_SELL emitted on 2x hit");
  if (received !== null) {
    const r = received as ExecuteSellPayload;
    assert(r.triggeredBy.kind === "multiplier", "triggeredBy.kind === 'multiplier'");
    assert(r.fraction === 1, "fraction === 1 (100% exit)");
  }
}

async function testPriceExitTrigger(): Promise<void> {
  console.log("\n[Test 2] Price exit ($3500) fires EXECUTE_SELL");

  const exits: PartialExit[] = [
    { percent: 50, target: { kind: "price", usd: 3500 } },
  ];
  const position = makePosition("pos-price-002", 3000, exits);

  let received: ExecuteSellPayload | null = null;
  const handler = (p: ExecuteSellPayload): void => {
    if (p.positionId === "pos-price-002") received = p;
  };
  bus.once("EXECUTE_SELL", handler);

  mockPriceUsd = 3200;
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);

  mockPriceUsd = 3600;
  await wait(6_000);

  assert(received !== null, "EXECUTE_SELL emitted on price hit");
  if (received !== null) {
    const r = received as ExecuteSellPayload;
    assert(r.triggeredBy.kind === "price", "triggeredBy.kind === 'price'");
    assert(r.fraction === 0.5, "fraction === 0.5 (50% partial exit)");
  }
}

async function testPartialExitSequence(): Promise<void> {
  console.log("\n[Test 3] Partial exit sequence — two targets, fired one at a time");

  const exits: PartialExit[] = [
    { percent: 50, target: { kind: "multiplier", value: 2 } },
    { percent: 50, target: { kind: "multiplier", value: 5 } },
  ];
  const position = makePosition("pos-partial-003", 100, exits);

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

  assert(received.length === 1, "First exit fired at 2x");
  const first = received[0];
  if (first !== undefined) {
    assert(first.fraction === 0.5, "First exit fraction === 0.5");
  }
  assert(getActiveWatcherCount() >= 1, "Watcher still alive for second exit");

  mockPriceUsd = 510;
  await wait(6_000);

  assert(received.length === 2, "Second exit fired at 5x");
  const second = received[1];
  if (second !== undefined) {
    assert(second.fraction === 0.5, "Second exit fraction === 0.5");
  }

  bus.off("EXECUTE_SELL", handler);
}

async function testDuplicateTradeExecutedGuard(): Promise<void> {
  console.log("\n[Test 4] Duplicate TRADE_EXECUTED → only one watcher");

  mockPriceUsd = 50;
  const countBefore = getActiveWatcherCount();

  const exits: PartialExit[] = [
    { percent: 100, target: { kind: "price", usd: 9999 } },
  ];
  const position = makePosition("pos-dup-004", 50, exits);

  bus.emit("TRADE_EXECUTED", position);
  bus.emit("TRADE_EXECUTED", position);
  await wait(200);

  assert(
    getActiveWatcherCount() === countBefore + 1,
    "Exactly one watcher spawned for duplicate TRADE_EXECUTED",
  );

  const cleanup: ExecuteSellPayload = {
    positionId: "pos-dup-004",
    fraction: 1,
    triggeredBy: { kind: "price", usd: 9999 },
    emittedAt: Date.now(),
  };
  bus.emit("EXECUTE_SELL", cleanup);
  await wait(100);
}

async function testCopyTradeRequestShape(): Promise<void> {
  console.log("\n[Test 5] COPY_TRADE_REQUEST carries valid TradeIntent");

  let received: TradeIntent | null = null;
  const handler = (intent: TradeIntent): void => {
    received = intent;
  };
  bus.once("COPY_TRADE_REQUEST", handler);

  const mockIntent: TradeIntent = {
    intentId: "copy-0xswap-1",
    userId: "copy-trade:smart-money-1",
    channel: "webchat",
    address: "0xtoken123",
    chain: "evm",
    amount: { value: 5000, unit: "USD" },
    exits: [],
    urgency: "NORMAL",
    rawText: "Copy trade from smart-money-1: BUY TOKEN/USDC $5000 on ethereum",
    createdAt: Date.now(),
  };

  bus.emit("COPY_TRADE_REQUEST", mockIntent);
  await wait(100);

  assert(received !== null, "COPY_TRADE_REQUEST received on bus");
  if (received !== null) {
    const intent = received as TradeIntent;
    assert(
      typeof intent.amount === "object" && "value" in intent.amount,
      "amount is { value, unit } — not a bare number",
    );
    assert(
      intent.chain === "evm" || intent.chain === "solana",
      "chain is ChainClass",
    );
    assert(intent.urgency === "NORMAL", "urgency === 'NORMAL'");
    assert(Array.isArray(intent.exits), "exits is an array");
  }
}

async function testWalletManagement(): Promise<void> {
  console.log("\n[Test 6] Wallet add / remove");

  const countBefore = getWatchedWalletCount();
  const testAddr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const testAddrLower = testAddr.toLowerCase();

  addWalletDirectly({ address: testAddr, label: "test-wallet", chain: "evm" });
  await wait(100);

  assert(getWatchedWalletCount() === countBefore + 1, "Wallet count +1 after add");
  assert(
    getWatchedWalletAddresses().includes(testAddrLower),
    "Wallet address tracked (lowercase)",
  );

  (bus as unknown as { emit: (e: string, p: unknown) => void }).emit(
    "REMOVE_WATCHED_WALLET",
    testAddr,
  );
  await wait(100);

  assert(getWatchedWalletCount() === countBefore, "Wallet count restored after remove");
  assert(
    !getWatchedWalletAddresses().includes(testAddrLower),
    "Wallet address gone after remove",
  );
}

// Runner

async function runAll(): Promise<void> {
  console.log("=== Hawkeye Monitor + CopyTrade Smoke Tests ===");

  startMonitorAgent();
  startCopyTradeAgent();

  await testMultiplierExitTrigger();
  await testPriceExitTrigger();
  await testPartialExitSequence();
  await testDuplicateTradeExecutedGuard();
  await testCopyTradeRequestShape();
  await testWalletManagement();

  console.log(`\n=== ${passed} passed  ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void runAll();