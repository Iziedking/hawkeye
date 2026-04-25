// Gateway wiring: OpenClaw adapter <-> Intent Parser <-> Event Bus.
// 0G Compute (LLM fallback) and 0G Storage (audit trail) are best-effort.

import process from "node:process";
import { bus } from "../shared/event-bus";
import { OgComputeClient } from "../integrations/0g/compute";
import { OgStorageClient } from "../integrations/0g/storage";
import type { InboundMessage } from "./openclaw-adapter";
import { OpenClawAdapter } from "./openclaw-adapter";
import { parseIntent } from "./intent-parser";
import type { MessageChannel } from "../shared/types";

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

export async function startGateway(): Promise<GatewayHandle> {
  const adapter = new OpenClawAdapter();
  const replyByIntentId = new Map<string, PendingReply>();

  const llm = await tryInitCompute();
  const storage = tryInitStorage();

  adapter.onInboundMessage((msg) => {
    void handleInbound(msg, adapter, llm, storage, replyByIntentId);
  });

  const onExecuted = (pos: import("../shared/types").TradeExecutedPayload): void => {
    const pending = replyByIntentId.get(pos.intentId);
    if (!pending) return;
    const text = `Filled ${pos.filled.value} ${pos.filled.unit} @ $${pos.entryPriceUsd.toFixed(6)}. tx=${pos.txHash}`;
    void adapter.sendReply(pending.msg, text).catch((err) => {
      console.error("[gateway] reply on TRADE_EXECUTED failed:", err);
    });
    replyByIntentId.delete(pos.intentId);
  };

  const onStrategy = (d: import("../shared/types").StrategyDecision): void => {
    if (d.decision !== "AWAIT_USER_CONFIRM") return;
    const pending = replyByIntentId.get(d.intentId);
    if (!pending) return;
    void adapter
      .sendReply(pending.msg, `Confirm to proceed: ${d.reason}`)
      .catch((err) => console.error("[gateway] reply on CONFIRM failed:", err));
  };

  const onSafety = (r: import("../shared/types").SafetyReport): void => {
    if (r.score >= 70 && r.flags.length === 0) return;
    const pending = replyByIntentId.get(r.intentId);
    if (!pending) return;
    void adapter
      .sendReply(pending.msg, `Safety ${r.score}/100 — flags: ${r.flags.join(", ") || "none"}`)
      .catch((err) => console.error("[gateway] reply on SAFETY failed:", err));
  };

  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("SAFETY_RESULT", onSafety);

  await adapter.connect();

  return {
    adapter,
    stop: () => {
      bus.off("TRADE_EXECUTED", onExecuted);
      bus.off("STRATEGY_DECISION", onStrategy);
      bus.off("SAFETY_RESULT", onSafety);
      adapter.close();
    },
  };
}

async function handleInbound(
  msg: InboundMessage,
  adapter: OpenClawAdapter,
  llm: OgComputeClient | null,
  storage: OgStorageClient | null,
  replyByIntentId: Map<string, PendingReply>,
): Promise<void> {
  const parseDeps = llm !== null ? { llm } : {};
  const intent = await parseIntent(
    {
      text: msg.text,
      userId: msg.userId,
      channel: normalizeChannel(msg.channel),
    },
    parseDeps,
  );

  if (intent === null) {
    void adapter
      .sendReply(msg, "Couldn't find a token address in that message.")
      .catch((err) => console.error("[gateway] reply failed:", err));
    return;
  }

  const pending: PendingReply = { msg, rootHash: null };
  replyByIntentId.set(intent.intentId, pending);
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

async function tryInitCompute(): Promise<OgComputeClient | null> {
  try {
    const client = new OgComputeClient();
    await client.ready();
    console.log("[gateway] 0G Compute ready");
    return client;
  } catch (err) {
    console.warn(
      "[gateway] 0G Compute unavailable — running regex-only parser:",
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

// Entrypoint when invoked directly: `npx tsx src/gateway/index.ts`.
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
