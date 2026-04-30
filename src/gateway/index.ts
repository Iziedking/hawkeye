// Gateway wiring: OpenClaw adapter <-> LLM Router <-> Event Bus.
// 0G Compute (router + conversational) and 0G Storage (audit trail) are best-effort.

import process from "node:process";
import { randomUUID } from "node:crypto";
import { bus } from "../shared/event-bus";
import { OgComputeClient } from "../integrations/0g/compute";
import { OgStorageClient } from "../integrations/0g/storage";
import type { InboundMessage } from "./openclaw-adapter";
import { OpenClawAdapter } from "./openclaw-adapter";
import { routeMessage } from "./llm-router";
import type { RouterResult } from "./llm-router";
import type {
  MessageChannel,
  TradeIntent,
  TradeAmount,
  ChainClass,
  TradingMode,
} from "../shared/types";

const KNOWN_CHANNELS: MessageChannel[] = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "webchat",
];

function normalizeChannel(raw: string): MessageChannel {
  const lower = raw.toLowerCase();
  return (KNOWN_CHANNELS as readonly string[]).includes(lower)
    ? (lower as MessageChannel)
    : "webchat";
}

export type GatewayHandle = {
  adapter: OpenClawAdapter;
  stop: () => void;
};

type PendingReply = {
  msg: InboundMessage;
  rootHash: string | null;
};

const CONVERSATIONAL_PROMPT = [
  "You are HAWKEYE, an autonomous on-chain crypto agent. You help users with trading, research, and everything on-chain.",
  "",
  "Your capabilities:",
  "- Trade tokens instantly (degen snipes) or with careful analysis",
  "- Research tokens for safety, liquidity, and price data",
  "- Track wallets and copy trades",
  "- Bridge assets across chains",
  "- Monitor positions and manage portfolios",
  "- Find alpha: trending tokens, smart money flows, arbitrage opportunities",
  "",
  "Rules:",
  "- Be direct and concise. No fluff.",
  "- Never hallucinate token prices, safety scores, or on-chain data. If you don't have live data, say so.",
  '- When relevant, mention your capabilities: "Paste a contract address and I\'ll analyze or trade it for you."',
  "- Stay crypto-native. You understand DeFi, DEXes, MEV, liquidity, tokenomics.",
  '- If the user seems to want to trade, guide them: "Send me the contract address to get started."',
].join("\n");

export async function startGateway(): Promise<GatewayHandle> {
  const adapter = new OpenClawAdapter();
  const replyByRequestId = new Map<string, PendingReply>();

  const llm = await tryInitCompute();
  const storage = tryInitStorage();

  adapter.onInboundMessage((msg) => {
    void handleInbound(msg, adapter, llm, storage, replyByRequestId);
  });

  const onExecuted = (pos: import("../shared/types").TradeExecutedPayload): void => {
    const pending = replyByRequestId.get(pos.intentId);
    if (!pending) return;
    const text = `Filled ${pos.filled.value} ${pos.filled.unit} @ $${pos.entryPriceUsd.toFixed(6)}. tx=${pos.txHash}`;
    void adapter.sendReply(pending.msg, text).catch((err) => {
      console.error("[gateway] reply on TRADE_EXECUTED failed:", err);
    });
    replyByRequestId.delete(pos.intentId);
  };

  const onStrategy = (d: import("../shared/types").StrategyDecision): void => {
    if (d.decision !== "AWAIT_USER_CONFIRM") return;
    const pending = replyByRequestId.get(d.intentId);
    if (!pending) return;
    void adapter
      .sendReply(pending.msg, `Confirm to proceed: ${d.reason}`)
      .catch((err) => console.error("[gateway] reply on CONFIRM failed:", err));
  };

  const onSafety = (r: import("../shared/types").SafetyReport): void => {
    if (r.score >= 70 && r.flags.length === 0) return;
    const pending = replyByRequestId.get(r.intentId);
    if (!pending) return;
    void adapter
      .sendReply(pending.msg, `Safety ${r.score}/100 — flags: ${r.flags.join(", ") || "none"}`)
      .catch((err) => console.error("[gateway] reply on SAFETY failed:", err));
  };

  const onResearchResult = (res: import("../shared/types").ResearchResult): void => {
    const pending = replyByRequestId.get(res.requestId);
    if (!pending) return;
    replyByRequestId.delete(res.requestId);
    void adapter
      .sendReply(pending.msg, res.summary)
      .catch((err) => console.error("[gateway] reply on RESEARCH_RESULT failed:", err));
  };

  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("RESEARCH_RESULT", onResearchResult);

  await adapter.connect();

  return {
    adapter,
    stop: () => {
      bus.off("TRADE_EXECUTED", onExecuted);
      bus.off("STRATEGY_DECISION", onStrategy);
      bus.off("SAFETY_RESULT", onSafety);
      bus.off("RESEARCH_RESULT", onResearchResult);
      adapter.close();
    },
  };
}

async function handleInbound(
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  llm: OgComputeClient | null,
  storage: OgStorageClient | null,
  replyByRequestId: Map<string, PendingReply>,
): Promise<void> {
  const routerDeps = llm !== null ? { llm } : {};
  const result = await routeMessage(
    {
      text: msg.text,
      userId: msg.userId,
      channel: normalizeChannel(msg.channel),
    },
    routerDeps,
  );

  console.log(
    `[gateway] routed: category=${result.category} confidence=${result.confidence.toFixed(2)}`,
  );

  switch (result.category) {
    case "DEGEN_SNIPE":
    case "TRADE":
      return handleTradeIntent(result, msg, adapter, storage, replyByRequestId);

    case "RESEARCH_TOKEN":
      return handleResearchToken(result, msg, adapter, replyByRequestId);

    case "RESEARCH_WALLET":
      return handleResearchWallet(result, msg, adapter);

    case "COPY_TRADE":
      return handleCopyTrade(result, msg, adapter);

    case "BRIDGE":
      return handleComingSoon(result, msg, adapter, "bridging assets across chains");

    case "PORTFOLIO":
      return handleComingSoon(result, msg, adapter, "portfolio tracking and PnL reports");

    case "SETTINGS":
      return handleSettings(result, msg, adapter);

    case "GENERAL_QUERY":
      return handleConversational(result, msg, adapter, llm);

    case "UNKNOWN":
    default:
      return handleConversational(result, msg, adapter, llm);
  }
}

function handleTradeIntent(
  result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  storage: OgStorageClient | null,
  replyByRequestId: Map<string, PendingReply>,
): void {
  const d = result.data;
  const address = typeof d["address"] === "string" ? d["address"] : null;
  const chain = d["chain"] === "evm" || d["chain"] === "solana" ? (d["chain"] as ChainClass) : null;

  if (address === null || chain === null) {
    void adapter
      .sendReply(
        msg,
        "I detected a trade intent but couldn't extract a valid token address. Paste the contract address and I'll handle it.",
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
    return;
  }

  const amountRaw = d["amount"] as Record<string, unknown> | null | undefined;
  let amount: TradeAmount = { value: 0, unit: "NATIVE" };
  if (amountRaw !== null && amountRaw !== undefined && typeof amountRaw === "object") {
    const v = typeof amountRaw["value"] === "number" ? amountRaw["value"] : 0;
    const u = amountRaw["unit"];
    const unit: TradeAmount["unit"] = u === "USD" || u === "TOKEN" || u === "NATIVE" ? u : "NATIVE";
    amount = { value: Number.isFinite(v) && v > 0 ? v : 0, unit };
  }

  const urgencyRaw = d["urgency"];
  const urgency: TradingMode =
    urgencyRaw === "INSTANT" || urgencyRaw === "CAREFUL" ? urgencyRaw : "NORMAL";

  const intent: TradeIntent = {
    intentId: result.id,
    userId: result.userId,
    channel: result.channel,
    address,
    chain,
    amount,
    exits: [],
    urgency,
    rawText: result.rawText,
    createdAt: result.routedAt,
  };

  const pending: PendingReply = { msg, rootHash: null };
  replyByRequestId.set(intent.intentId, pending);
  bus.emit("TRADE_REQUEST", intent);

  if (storage !== null) {
    void storage
      .writeJson(intent.intentId, intent)
      .then((res) => {
        pending.rootHash = res.rootHash;
        console.log(
          `[gateway] 0G Storage intent=${intent.intentId} root=${res.rootHash} tx=${res.txHash}`,
        );
      })
      .catch((err) => {
        console.error("[gateway] og-storage write failed:", err);
      });
  }
}

function handleResearchToken(
  result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  replyByRequestId: Map<string, PendingReply>,
): void {
  const d = result.data;
  const address = typeof d["address"] === "string" ? d["address"] : null;
  const question = typeof d["question"] === "string" ? d["question"] : result.rawText;
  const chain = d["chain"] === "evm" || d["chain"] === "solana" ? (d["chain"] as ChainClass) : null;

  const requestId = randomUUID();
  replyByRequestId.set(requestId, { msg, rootHash: null });

  bus.emit("RESEARCH_REQUEST", {
    requestId,
    userId: result.userId,
    channel: result.channel,
    address,
    tokenName: typeof d["tokenName"] === "string" ? d["tokenName"] : null,
    chain,
    question,
    rawText: result.rawText,
    createdAt: Date.now(),
  });

  if (address !== null) {
    void adapter
      .sendReply(
        msg,
        `Researching token ${address}... I'll analyze safety, liquidity, and price data.`,
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  } else {
    void adapter
      .sendReply(
        msg,
        `Looking into that for you. For the most detailed analysis, paste the contract address directly.`,
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  }
}

function handleResearchWallet(
  result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
): void {
  const d = result.data;
  const wallet = typeof d["walletAddress"] === "string" ? d["walletAddress"] : null;

  if (wallet !== null) {
    void adapter
      .sendReply(
        msg,
        `Wallet tracking for ${wallet.slice(0, 8)}...${wallet.slice(-4)} is coming soon. I'll be able to show you their recent trades, PnL, and let you copy their moves.`,
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  } else {
    void adapter
      .sendReply(
        msg,
        `Wallet research is coming soon. Paste a wallet address and I'll be able to track their activity and let you copy their trades.`,
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  }
}

function handleCopyTrade(
  result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
): void {
  const d = result.data;
  const wallet = typeof d["walletAddress"] === "string" ? d["walletAddress"] : null;

  bus.emit("COPY_TRADE_REQUEST", {
    intentId: randomUUID(),
    userId: result.userId,
    channel: result.channel,
    address: wallet ?? "",
    chain: d["chain"] === "solana" ? ("solana" as ChainClass) : ("evm" as ChainClass),
    amount: { value: 0, unit: "NATIVE" as const },
    exits: [],
    urgency: "NORMAL" as TradingMode,
    rawText: result.rawText,
    createdAt: Date.now(),
  });

  if (wallet !== null) {
    void adapter
      .sendReply(
        msg,
        `Copy trading for ${wallet.slice(0, 8)}...${wallet.slice(-4)} is coming soon. You'll be able to auto-mirror their trades in real-time.`,
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  } else {
    void adapter
      .sendReply(msg, `Copy trading is coming soon. Paste a wallet address to set up auto-copy.`)
      .catch((err) => console.error("[gateway] reply failed:", err));
  }
}

function handleSettings(result: RouterResult, msg: InboundMessage, adapter: OpenClawAdapter): void {
  const d = result.data;
  const setting = typeof d["setting"] === "string" ? d["setting"] : "unknown";
  const value = typeof d["value"] === "string" ? d["value"] : "";

  void adapter
    .sendReply(
      msg,
      `Settings update noted: ${setting} → ${value}. Persistent settings are coming soon — for now this applies to your current session.`,
    )
    .catch((err) => console.error("[gateway] reply failed:", err));
}

function handleComingSoon(
  _result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  capability: string,
): void {
  void adapter
    .sendReply(
      msg,
      `I understand you're looking for ${capability}. This is coming soon. For now, I can help you with trading (paste a contract address), token research, or market questions.`,
    )
    .catch((err) => console.error("[gateway] reply failed:", err));
}

async function handleConversational(
  result: RouterResult,
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  llm: OgComputeClient | null,
): Promise<void> {
  if (llm === null) {
    void adapter
      .sendReply(
        msg,
        "I'm running in limited mode right now. Paste a contract address to trade, or try again in a moment for full capabilities.",
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
    return;
  }

  try {
    const resp = await llm.infer({
      system: CONVERSATIONAL_PROMPT,
      user: result.rawText,
      temperature: 0.7,
      maxTokens: 300,
    });
    void adapter
      .sendReply(msg, resp.text)
      .catch((err) => console.error("[gateway] reply failed:", err));
  } catch {
    void adapter
      .sendReply(
        msg,
        "I'm having trouble processing that right now. You can paste a contract address to trade, or ask me about any token.",
      )
      .catch((err) => console.error("[gateway] reply failed:", err));
  }
}

async function tryInitCompute(): Promise<OgComputeClient | null> {
  try {
    const client = new OgComputeClient();
    await client.ready();
    console.log("[gateway] 0G Compute ready");
    return client;
  } catch (err) {
    console.warn(
      "[gateway] 0G Compute unavailable — running with limited routing:",
      (err as Error).message,
    );
    return null;
  }
}

function tryInitStorage(): OgStorageClient | null {
  try {
    const client = new OgStorageClient();
    console.log("[gateway] 0G Storage client initialized");
    return client;
  } catch (err) {
    console.warn(
      "[gateway] 0G Storage unavailable — skipping audit writes:",
      (err as Error).message,
    );
    return null;
  }
}

if (require.main === module) {
  startGateway()
    .then((h) => {
      const shutdown = (): void => {
        h.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[gateway] boot failed:", err);
      process.exit(1);
    });
}
