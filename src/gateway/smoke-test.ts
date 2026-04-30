// Gateway smoke test. Uses a fake WebSocket to test the full adapter lifecycle.

import process from "node:process";
import { OpenClawAdapter, decodeChatEvent } from "./openclaw-adapter";
import { parseIntent } from "./intent-parser.legacy";


type Listener<E> = (ev: E) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly OPEN = 1;
  readyState = 0;
  readonly url: string;

  private openListeners: Array<Listener<Event>> = [];
  private messageListeners: Array<Listener<{ data: string }>> = [];
  private closeListeners: Array<Listener<{ code: number; reason: string; wasClean: boolean }>> = [];
  private errorListeners: Array<Listener<Event>> = [];

  sentFrames: string[] = [];

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.fakeOpen());
  }

  addEventListener(
    name: "open" | "message" | "close" | "error",
    fn: Listener<unknown>,
  ): void {
    if (name === "open") this.openListeners.push(fn as Listener<Event>);
    else if (name === "message") this.messageListeners.push(fn as Listener<{ data: string }>);
    else if (name === "close")
      this.closeListeners.push(
        fn as Listener<{ code: number; reason: string; wasClean: boolean }>,
      );
    else if (name === "error") this.errorListeners.push(fn as Listener<Event>);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code: number, reason: string): void {
    // Match Node's native WebSocket: 1008 is rejected.
    if (code === 1008) {
      throw new Error("invalid code");
    }
    this.readyState = 3;
    for (const fn of this.closeListeners) {
      fn({ code, reason, wasClean: true });
    }
  }

  fakeOpen(): void {
    this.readyState = 1;
    for (const fn of this.openListeners) fn({} as Event);
  }

  fakeServerSend(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const fn of this.messageListeners) fn({ data });
  }

  getLastSentFrame(): unknown {
    const last = this.sentFrames.at(-1);
    if (last === undefined) return null;
    return JSON.parse(last);
  }
}


let failures = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function runAdapterLifecycle(): Promise<void> {
  console.log("\n[1] adapter lifecycle");

  // Install fake globally. Remember the original so we can restore.
  const origWS = (globalThis as Record<string, unknown>)["WebSocket"];
  let lastFake: FakeWebSocket | null = null;
  (globalThis as Record<string, unknown>)["WebSocket"] = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastFake = this;
    }
  };

  try {
    const messages: unknown[] = [];
    const adapter = new OpenClawAdapter({
      url: "ws://fake.local:1/",
      token: "test-token",
      log: () => {
        /* silent in smoke */
      },
    });
    adapter.onInboundMessage((m) => messages.push(m));

    const connectPromise = adapter.connect();

    // Let the microtask fire so the fake "opens".
    await new Promise((r) => setImmediate(r));
    assert(lastFake !== null, "fake socket constructed");
    const fake = lastFake as unknown as FakeWebSocket;

    // Server: send connect.challenge.
    fake.fakeServerSend({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n-1", ts: Date.now() },
    });

    // Next sent frame should be the connect req.
    await new Promise((r) => setImmediate(r));
    const connectReq = fake.getLastSentFrame() as Record<string, unknown> | null;
    assert(connectReq !== null, "client sent a frame after challenge");
    assert(connectReq?.["type"] === "req", "connect frame has type=req");
    assert(connectReq?.["method"] === "connect", "connect frame method=connect");
    const connectParams = connectReq?.["params"] as Record<string, unknown> | undefined;
    const authBlock = connectParams?.["auth"] as Record<string, unknown> | undefined;
    assert(authBlock?.["token"] === "test-token", "auth.token is forwarded");

    // Server: hello-ok.
    fake.fakeServerSend({
      type: "res",
      id: connectReq?.["id"],
      ok: true,
      payload: {
        features: { methods: ["chat.send", "send"], events: ["chat", "tick"] },
        policy: { tickIntervalMs: 1_000 },
      },
    });

    await connectPromise;
    assert(true, "handshake resolved");

    // Server: chat event with a synthesized payload (shape deliberately
    // permissive so decodeChatEvent has work to do).
    fake.fakeServerSend({
      type: "event",
      event: "chat",
      seq: 1,
      payload: {
        id: "env-123",
        channel: "telegram",
        senderId: "user-42",
        conversationId: "conv-7",
        text: "buy 0.5 eth of 0x1234567890abcdef1234567890abcdef12345678",
        ts: 1_700_000_000_000,
      },
    });

    await new Promise((r) => setImmediate(r));
    assert(messages.length === 1, "inbound handler received one message");
    const msg = messages[0] as { channel: string; userId: string; text: string; envelopeId: string; conversationId: string | null };
    assert(msg.channel === "telegram", "channel normalized");
    assert(msg.userId === "user-42", "userId extracted from senderId");
    assert(msg.conversationId === "conv-7", "conversationId extracted");
    assert(msg.envelopeId === "env-123", "envelopeId extracted from id");
    assert(msg.text.includes("0x1234567890abcdef"), "text preserved");

    // sendReply should serialize a chat.send req.
    const sendPromise = adapter.sendReply(
      {
        envelopeId: msg.envelopeId,
        channel: msg.channel,
        userId: msg.userId,
        conversationId: msg.conversationId,
        text: msg.text,
        receivedAt: Date.now(),
        raw: {},
      },
      "got it, checking safety",
    );
    await new Promise((r) => setImmediate(r));

    const reply = fake.getLastSentFrame() as Record<string, unknown> | null;
    assert(reply?.["type"] === "req", "reply is a req frame");
    assert(reply?.["method"] === "chat.send", "reply method=chat.send");
    const replyParams = reply?.["params"] as Record<string, unknown> | undefined;
    assert(replyParams?.["channel"] === "telegram", "reply.params.channel");
    assert(replyParams?.["to"] === "user-42", "reply.params.to");
    assert(replyParams?.["text"] === "got it, checking safety", "reply.params.text");
    assert(replyParams?.["envelopeId"] === "env-123", "reply.params.envelopeId");
    assert(replyParams?.["conversationId"] === "conv-7", "reply.params.conversationId");

    // Resolve the sendReply promise so we don't leak.
    fake.fakeServerSend({ type: "res", id: reply?.["id"], ok: true, payload: {} });
    await sendPromise;
    assert(true, "chat.send resolved");

    adapter.close();
  } finally {
    (globalThis as Record<string, unknown>)["WebSocket"] = origWS;
  }
}

async function runPureHelpers(): Promise<void> {
  console.log("\n[2] pure helpers");

  // decodeChatEvent with minimal payload.
  const a = decodeChatEvent(
    { sender: "u-9", text: "hello", platform: "whatsapp" },
    { id: "e-1" },
  );
  assert(a !== null && a.userId === "u-9", "decodeChatEvent: fallback to sender");
  assert(a !== null && a.channel === "whatsapp", "decodeChatEvent: fallback to platform");
  assert(a !== null && a.envelopeId === "e-1", "decodeChatEvent: envelopeId from envelope.id");

  // decodeChatEvent rejects when no user id.
  const b = decodeChatEvent({ text: "no sender" }, {});
  assert(b === null, "decodeChatEvent: null when no userId");

  // parseIntent EVM. Regex-only path — no llm dep passed.
  const evm = await parseIntent({
    text: "ape now 0xabcDEF0123456789abcdef0123456789abcdef01",
    userId: "u-1",
    channel: "telegram",
  });
  assert(evm !== null && evm.chain === "evm", "parseIntent: EVM chain");
  assert(evm !== null && evm.urgency === "INSTANT", "parseIntent: urgency=INSTANT");

  // parseIntent Solana.
  const sol = await parseIntent({
    text: "careful on EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v please",
    userId: "u-2",
    channel: "whatsapp",
  });
  assert(sol !== null && sol.chain === "solana", "parseIntent: Solana chain");
  assert(sol !== null && sol.urgency === "CAREFUL", "parseIntent: urgency=CAREFUL");

  // parseIntent returns null on noise (regex-only, no llm wired).
  const none = await parseIntent({ text: "hi", userId: "u-3", channel: "webchat" });
  assert(none === null, "parseIntent: null on no address");
}

async function main(): Promise<void> {
  console.log("gateway smoke test");
  await runPureHelpers();
  await runAdapterLifecycle();

  console.log();
  if (failures === 0) {
    console.log("ALL PASS");
    process.exit(0);
  } else {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
}

void main();
