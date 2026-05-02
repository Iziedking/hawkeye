import { loadEnvLocal } from "../../shared/env";
loadEnvLocal();

import { bus } from "../../shared/event-bus";
import { startResearchAgent } from "./index";
import { OpenRouterClient } from "../../integrations/openrouter/index";
import type { ResearchResult, ResearchRequest, ResearchSubIntent } from "../../shared/types";

const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";

const tests: Array<{ req: ResearchRequest; label: string }> = [
  {
    label: "TOKEN_LOOKUP",
    req: {
      requestId: "smoke-token-lookup",
      userId: "samuel", channel: "webchat", chain: "evm",
      address: PEPE, tokenName: "PEPE",
      question: "Tell me about PEPE",
      rawText: "tell me about PEPE",
      createdAt: Date.now(),
      subIntent: "TOKEN_LOOKUP",
      tools: ["dexscreener", "goplus", "coingecko", "etherscan"],
    },
  },
  {
    label: "SAFETY_CHECK",
    req: {
      requestId: "smoke-safety-check",
      userId: "samuel", channel: "webchat", chain: "evm",
      address: PEPE, tokenName: "PEPE",
      question: "Is PEPE safe?",
      rawText: "is PEPE safe?",
      createdAt: Date.now(),
      subIntent: "SAFETY_CHECK",
      tools: ["goplus", "honeypot", "etherscan", "dexscreener"],
    },
  },
  {
    label: "WHALE_ANALYSIS",
    req: {
      requestId: "smoke-whale-analysis",
      userId: "samuel", channel: "webchat", chain: "evm",
      address: PEPE, tokenName: "PEPE",
      question: "Who holds PEPE?",
      rawText: "who holds the most PEPE",
      createdAt: Date.now(),
      subIntent: "WHALE_ANALYSIS",
      tools: ["arkham", "etherscan", "dexscreener"],
    },
  },
  {
    label: "PRICE_ACTION",
    req: {
      requestId: "smoke-price-action",
      userId: "samuel", channel: "webchat", chain: "evm",
      address: PEPE, tokenName: "PEPE",
      question: "How is PEPE doing price-wise?",
      rawText: "how is PEPE doing",
      createdAt: Date.now(),
      subIntent: "PRICE_ACTION",
      tools: ["dexscreener", "coingecko", "geckoterminal"],
    },
  },
  {
    label: "TRENDING",
    req: {
      requestId: "smoke-trending",
      userId: "samuel", channel: "webchat", chain: "evm",
      address: null, tokenName: null,
      question: "What's trending on base?",
      rawText: "what's trending on base",
      createdAt: Date.now(),
      subIntent: "TRENDING",
      tools: ["dexscreener", "coingecko", "arkham_trending"],
    },
  },
  {
    label: "MARKET_OVERVIEW",
    req: {
      requestId: "smoke-market-overview",
      userId: "samuel", channel: "webchat", chain: null,
      address: null, tokenName: null,
      question: "What's the market doing?",
      rawText: "what's the market doing",
      createdAt: Date.now(),
      subIntent: "MARKET_OVERVIEW",
      tools: ["coingecko", "feargreed"],
    },
  },
];

const llm = new OpenRouterClient();
const agent = startResearchAgent({ llm });

let passed = 0;
let failed = 0;
const pending = new Set(tests.map((t) => t.req.requestId));

const overallTimeout = setTimeout(() => {
  const remaining = [...pending].join(", ");
  console.error(`[smoke] timed out — no result for: ${remaining}`);
  agent.stop();
  process.exit(1);
}, 90_000);

bus.on("RESEARCH_RESULT", (result: ResearchResult) => {
  if (!pending.has(result.requestId)) return;
  pending.delete(result.requestId);

  const test = tests.find((t) => t.req.requestId === result.requestId);
  const label = test?.label ?? result.requestId;

  if (!result.summary || result.summary.trim() === "") {
    console.error(`[smoke] FAIL  ${label} — empty summary`);
    failed++;
  } else {
    console.log(`[smoke] PASS  ${label} (subIntent=${result.subIntent ?? "—"}, score=${result.safetyScore ?? "—"})`);
    console.log(`       ${result.summary.slice(0, 120)}...`);
    passed++;
  }

  if (pending.size === 0) {
    clearTimeout(overallTimeout);
    agent.stop();
    console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
});

// Fire all test requests in sequence with a short delay to avoid rate-limits
(async () => {
  for (const { req } of tests) {
    bus.emit("RESEARCH_REQUEST", req);
    await new Promise((r) => setTimeout(r, 500));
  }
})();
