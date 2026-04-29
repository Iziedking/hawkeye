// Smoke test for the Research Agent — runs against real external APIs.
// Not part of the production build. Run manually to verify both jobs
// are wiring up correctly before committing.
//
// Usage:
//   npx tsx src/agents/research.smoke-test.ts         → both jobs
//   npx tsx src/agents/research.smoke-test.ts job1    → polling loop (ALPHA_FOUND) only
//   npx tsx src/agents/research.smoke-test.ts job2    → research request (RESEARCH_RESULT) only
//
// Keys needed for full coverage (add to .env.local):
//   ETHERSCAN_API_KEY, NEYNAR_API_KEY, TAVILY_API_KEY, OG_PRIVATE_KEY
//   BIRDEYE_API_KEY (Solana tokens only), BRAVE_API_KEY (Commit 5 Brave Search)
//   GOPLUS_API_KEY optional — free tier activates automatically when absent

import { loadEnvLocal } from "../shared/env";
loadEnvLocal();

import { bus } from "../shared/event-bus";
import type { AlphaFoundPayload, ResearchResult } from "../shared/types";
import { startResearchAgent } from "./research";

const mode   = process.argv[2] ?? "both";
const runJob1 = mode === "both" || mode === "job1";
const runJob2 = mode === "both" || mode === "job2";

// Track pending jobs so the process exits cleanly once both finish.
let pending = (runJob1 ? 1 : 0) + (runJob2 ? 1 : 0);
function jobDone(): void {
  pending--;
  if (pending <= 0) process.exit(0);
}

startResearchAgent();

// ─── Job 1 — Polling loop (ALPHA_FOUND) ───────────────────────────────────────
// The agent fires the first poll cycle immediately on start. We listen for
// ALPHA_FOUND for 90 seconds. Zero results is correct behaviour if nothing
// on DexScreener today passes all four gates — it means the filters are working.
if (runJob1) {
  let alphaCount = 0;

  bus.on("ALPHA_FOUND", (payload: AlphaFoundPayload) => {
    alphaCount++;
    console.log("\n─── ALPHA_FOUND ──────────────────────────────────────────────");
    console.log(`Token    : ${payload.address}`);
    console.log(`Chain    : ${payload.chainId}`);
    console.log(`Safety   : ${payload.safetyScore}/100`);
    console.log(`Liquidity: $${payload.liquidityUsd.toLocaleString()}`);
    console.log(`Reason   : ${payload.reason}`);
    console.log("──────────────────────────────────────────────────────────────");
  });

  // Print a heartbeat every 30s so you can see the loop is alive even when quiet.
  let elapsed = 0;
  const heartbeat = setInterval(() => {
    elapsed += 30;
    console.log(`[job1] ${elapsed}s elapsed — ALPHA_FOUND so far: ${alphaCount}`);
  }, 30_000);

  setTimeout(() => {
    clearInterval(heartbeat);
    const verdict = alphaCount > 0
      ? `${alphaCount} alpha signal(s) found.`
      : "No alpha found — filters are working (quiet market or no new tokens today).";
    console.log(`\n[job1] complete. ${verdict}`);
    jobDone();
  }, 90_000);
}

// ─── Job 2 — RESEARCH_REQUEST handler (RESEARCH_RESULT) ──────────────────────
// Fires a research question for PEPE (a real, well-known EVM token) and prints
// the full RESEARCH_RESULT. Expected to complete in 15–30s depending on API latency.
// If OPENROUTER_API_KEY is absent the summary will be a template string — that's fine.
if (runJob2) {
  bus.on("RESEARCH_RESULT", (result: ResearchResult) => {
    console.log("\n─── RESEARCH_RESULT ──────────────────────────────────────────");
    console.log(`Request  : ${result.requestId}`);
    console.log(`Address  : ${result.address}`);
    console.log(`Chain    : ${result.chain}`);
    console.log(`Safety   : ${result.safetyScore ?? "n/a"}/100`);
    console.log(`Price    : ${result.priceUsd    != null ? `$${result.priceUsd}` : "unknown"}`);
    console.log(`Liquidity: ${result.liquidityUsd != null ? `$${result.liquidityUsd.toLocaleString()}` : "unknown"}`);
    console.log(`Flags    : ${result.flags.length > 0 ? result.flags.join(", ") : "none"}`);
    console.log(`Summary  :\n${result.summary}`);
    console.log("──────────────────────────────────────────────────────────────");
    jobDone();
  });

  // Short delay so the agent's bus listener is registered before we fire.
  setTimeout(() => {
    bus.emit("RESEARCH_REQUEST", {
      requestId: "smoke-job2-001",
      userId:    "samuel",
      channel:   "webchat",
      address:   "0x6982508145454Ce325dDbE47a25d4ec3d2311933", // PEPE on Ethereum
      tokenName: "PEPE",
      chain:     "evm",
      question:  "Is this token safe to buy? What is the current market sentiment?",
      rawText:   "is PEPE safe?",
      createdAt: Date.now(),
    });
    console.log("[job2] RESEARCH_REQUEST fired for PEPE (0x6982...)");
  }, 500);

  // Safety net — if all APIs hang the process won't linger forever.
  setTimeout(() => {
    console.error("\n[job2] timeout: no RESEARCH_RESULT after 60s. Check network / missing keys.");
    jobDone();
  }, 60_000);
}
