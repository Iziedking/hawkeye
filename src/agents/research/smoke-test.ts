import { loadEnvLocal } from "../../shared/env";
loadEnvLocal();

import { bus } from "../../shared/event-bus";
import { startResearchAgent } from "./index";
import { OpenRouterClient } from "../../integrations/openrouter/index";
import type { ResearchResult, ResearchRequest } from "../../shared/types";

// Use OpenRouter instead of 0G Compute so the smoke test works without 0G keys.
const llm = new OpenRouterClient();
const agent = startResearchAgent({ llm });

const timeout = setTimeout(() => {
  console.error("[smoke] timed out after 60s — no RESEARCH_RESULT received");
  agent.stop();
  process.exit(1);
}, 60_000);

bus.on("RESEARCH_RESULT", (result: ResearchResult) => {
  clearTimeout(timeout);
  console.log("Summary:", result.summary);
  console.log("Safety score:", result.safetyScore);
  console.log("Price USD:", result.priceUsd);
  console.log("Liquidity USD:", result.liquidityUsd);
  console.log("Flags:", result.flags);
  agent.stop();
  process.exit(0);
});

const req: ResearchRequest = {
  requestId: "smoke-research-001",
  userId: "samuel",
  channel: "webchat",
  address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", // PEPE on ETH
  tokenName: "PEPE",
  chain: "evm",
  question: "Is this token safe to buy?",
  rawText: "is PEPE safe?",
  createdAt: Date.now(),
};

bus.emit("RESEARCH_REQUEST", req);
