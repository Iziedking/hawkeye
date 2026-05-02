import { loadEnvLocal } from "../../shared/env";
loadEnvLocal();

import { bus } from "../../shared/event-bus";
import { startSafetyAgent } from "./index";
import type { SafetyReport, TradeIntent } from "../../shared/types";

const agent = startSafetyAgent();

const timeout = setTimeout(() => {
  console.error("[smoke] timed out after 30s — no SAFETY_RESULT received");
  agent.stop();
  process.exit(1);
}, 30_000);

bus.on("SAFETY_RESULT", (report: SafetyReport) => {
  clearTimeout(timeout);
  console.log("Safety score:", report.score);
  console.log("Flags:", report.flags);
  console.log("Chain:", report.chainId);
  console.log("Sources:", report.sources.map((s) => `${s.provider}(ok=${s.ok})`).join(", "));
  agent.stop();
  process.exit(0);
});

const intent: TradeIntent = {
  intentId: "smoke-safety-001",
  userId: "samuel",
  channel: "webchat",
  address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", // PEPE on ETH
  chain: "evm",
  amount: { value: 0.1, unit: "NATIVE" },
  exits: [],
  urgency: "NORMAL",
  rawText: "test",
  createdAt: Date.now(),
};

bus.emit("TRADE_REQUEST", intent);
