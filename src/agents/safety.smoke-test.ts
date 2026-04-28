// Smoke test for the Safety Agent — runs against real external APIs.
// Not part of the production build. Run manually to verify the agent
// is wiring up correctly before committing.
//
// Usage:
//   npx tsx src/agents/safety.smoke-test.ts
//
// No keys required — GoPlus free tier, Honeypot.is, and RugCheck
// all work unauthenticated. DexScreener has no auth at all.

import { loadEnvLocal } from "../shared/env";
loadEnvLocal();

import { bus } from "../shared/event-bus";
import type { SafetyReport } from "../shared/types";
import { startSafetyAgent } from "./safety";

// Boot the agent so it starts listening on the bus.
startSafetyAgent();

// ─── Test cases ───────────────────────────────────────────────────────────────
// Add or swap addresses here to test different tokens.
// Use real on-chain addresses — the APIs need them to return meaningful data.
const TEST_CASES = [
  {
    label: "PEPE (EVM — expect high score, low flags)",
    address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    chain: "evm" as const,
  },
  {
    label: "Solana USDC (expect high score)",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chain: "solana" as const,
  },
];

let completed = 0;

bus.on("SAFETY_RESULT", (report: SafetyReport) => {
  const testCase = TEST_CASES.find(
    (t) => t.address.toLowerCase() === report.address.toLowerCase(),
  );

  console.log("\n─────────────────────────────────────────");
  console.log(`Token   : ${testCase?.label ?? report.address}`);
  console.log(`Chain   : ${report.chainId}`);
  console.log(`Score   : ${report.score}/100`);
  console.log(`Flags   : ${report.flags.length === 0 ? "none" : report.flags.join(", ")}`);
  console.log(`Sources : ${report.sources.map((s) => `${s.provider}(ok=${s.ok})`).join(", ")}`);
  console.log("─────────────────────────────────────────");

  completed += 1;
  if (completed >= TEST_CASES.length) {
    console.log("\nAll test cases complete.");
    process.exit(0);
  }
});

// Fire all test cases onto the bus.
for (const [i, tc] of TEST_CASES.entries()) {
  bus.emit("TRADE_REQUEST", {
    intentId: `smoke-${i}`,
    userId: "samuel",
    channel: "webchat",
    address: tc.address,
    chain: tc.chain,
    amount: { value: 0.1, unit: "NATIVE" },
    exits: [],
    urgency: "NORMAL",
    rawText: "smoke test",
    createdAt: Date.now(),
  });
}

// Safety net — exit after 30s if an API hangs and never responds.
setTimeout(() => {
  console.error("\nTimeout: no SAFETY_RESULT after 30s. Check network or API availability.");
  process.exit(1);
}, 30_000);
