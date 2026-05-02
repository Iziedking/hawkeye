// OpenClaw WebSocket adapter. Handles connect handshake, chat events,
// tick-watchdog, and reconnect with exponential backoff.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Public types

export type InboundMessage = {
  envelopeId: string;
  channel: string;
  userId: string;
  conversationId: string | null;
  text: string;
  receivedAt: number;
  raw: Record<string, unknown>;
};

export type SendReplyOptions = {
  legacyFallback?: boolean;
};

export type AdapterOptions = {
  url?: string;
  token?: string;
  configPath?: string;
  log?: (level: "info" | "warn" | "error" | "debug", msg: string) => void;
};

// Frame types

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

export type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

export type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type OpenClawFrame = EventFrame | ResFrame;

const DEFAULT_URL = "ws://127.0.0.1:18789";
const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_CHALLENGE_TIMEOUT_MS = 5_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const DEFAULT_TICK_INTERVAL_MS = 30_000;

// Node's native WebSocket rejects 1008, so we use 4xxx codes.
const CLOSE_NORMAL = 1000;
const CLOSE_TICK_TIMEOUT = 4000;
const CLOSE_PROTOCOL = 4001;

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
};

export class OpenClawAdapter {
  private readonly url: string;
  private readonly explicitToken: string | undefined;
  private readonly configPath: string;
  private readonly log: NonNullable<AdapterOptions["log"]>;

  private ws: WebSocket | null = null;
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;
  private pending = new Map<string, PendingRequest>();

  private backoffIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickWatchdog: ReturnType<typeof setTimeout> | null = null;
  private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;

  private connected = false;
  private closed = false;
  private serverFeatures: { methods: Set<string>; events: Set<string> } = {
    methods: new Set(),
    events: new Set(),
  };

  constructor(opts: AdapterOptions = {}) {
    this.url = opts.url ?? process.env["OPENCLAW_URL"] ?? DEFAULT_URL;
    this.explicitToken = opts.token;
    this.configPath = opts.configPath ?? join(homedir(), ".openclaw", "openclaw.json");
    this.log = opts.log ?? defaultLog;
  }

  onInboundMessage(handler: (msg: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("adapter is closed");
    if (typeof WebSocket === "undefined") {
      throw new Error("native WebSocket unavailable — Node 22+ required");
    }

    this.log("info", `connecting to ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connected = false;

    const handshake = new Promise<void>((resolve, reject) => {
      const fail = (err: Error): void => {
        this.clearTimers();
        try {
          ws.close(CLOSE_PROTOCOL, "handshake failed");
        } catch {
          // Already closing; swallow.
        }
        reject(err);
      };

      this.challengeTimer = setTimeout(() => {
        if (!this.connected) fail(new Error("connect.challenge timeout"));
      }, CONNECT_CHALLENGE_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        this.log("debug", "ws open, awaiting connect.challenge");
      });

      ws.addEventListener("message", (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        const frame = safeParse(raw);
        if (!frame || typeof frame !== "object") {
          this.log("warn", `non-JSON frame: ${raw.slice(0, 120)}`);
          return;
        }
        const f = frame as Record<string, unknown>;
        if (!this.connected && f["type"] === "event" && f["event"] === "connect.challenge") {
          this.clearChallengeTimer();
          const challengeFrame: EventFrame = {
            type: "event",
            event: "connect.challenge",
            payload: f["payload"],
            ...(typeof f["seq"] === "number" ? { seq: f["seq"] as number } : {}),
          };
          void this.sendConnect(challengeFrame)
            .then(() => {
              this.connected = true;
              this.backoffIndex = 0;
              this.armTickWatchdog();
              resolve();
            })
            .catch(fail);
          return;
        }
        this.dispatchFrame(frame);
      });

      ws.addEventListener("close", (ev) => {
        this.clearTimers();
        this.failAllPending(new Error("ws closed"));
        const wasConnected = this.connected;
        this.connected = false;
        this.ws = null;
        this.log(
          "info",
          `ws close code=${ev.code} reason=${ev.reason || "(none)"} wasClean=${ev.wasClean}`,
        );
        if (!wasConnected) {
          fail(new Error(`closed before handshake: ${ev.code} ${ev.reason}`));
        }
        if (!this.closed) this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        this.log("warn", "ws error event (see close for details)");
      });
    });

    await handshake;
  }

  close(code: number = CLOSE_NORMAL, reason: string = "adapter.close"): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearTimers();
    this.failAllPending(new Error("adapter closed"));
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.close(code, reason);
      } catch {
        // Node rejects invalid codes; swallow.
      }
    }
    this.ws = null;
  }

  async sendReply(
    inbound: InboundMessage,
    text: string,
    opts: SendReplyOptions = {},
  ): Promise<void> {
    const params: Record<string, unknown> = {
      channel: inbound.channel,
      to: inbound.userId,
      text,
      envelopeId: inbound.envelopeId,
    };
    if (inbound.conversationId !== null) {
      params["conversationId"] = inbound.conversationId;
    }

    try {
      await this.request("chat.send", params);
      return;
    } catch (err) {
      if (!opts.legacyFallback) throw err;
      this.log("warn", `chat.send failed, retrying via send: ${String(err)}`);
      await this.request("send", params);
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error(`cannot send '${method}': socket not open`);
    }
    const id = randomUUID();
    const frame: ReqFrame = { type: "req", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async sendConnect(challenge: EventFrame): Promise<void> {
    const payload = (challenge.payload ?? {}) as Record<string, unknown>;
    const nonce = typeof payload["nonce"] === "string" ? payload["nonce"] : null;
    if (nonce === null || nonce.trim().length === 0) {
      throw new Error("connect.challenge missing nonce");
    }

    const token = this.resolveToken();
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "HAWKEYE",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend",
        instanceId: randomUUID(),
      },
      caps: [],
      role: "operator",
      scopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ],
      ...(token !== null ? { auth: { token } } : {}),
    };

    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error("socket closed mid-handshake");
    }
    const id = randomUUID();
    const helloOk = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("connect request timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve,
        reject: (e) => {
          // Escalate auth errors to a distinct close code so callers can tell.
          reject(e);
        },
        timeout,
        method: "connect",
      });
      ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
    });

    this.recordServerFeatures(helloOk);
  }

  private recordServerFeatures(helloOk: unknown): void {
    if (!helloOk || typeof helloOk !== "object") return;
    const obj = helloOk as Record<string, unknown>;
    const features = obj["features"];
    if (features && typeof features === "object") {
      const f = features as Record<string, unknown>;
      const methods = Array.isArray(f["methods"]) ? (f["methods"] as unknown[]) : [];
      const events = Array.isArray(f["events"]) ? (f["events"] as unknown[]) : [];
      this.serverFeatures.methods = new Set(
        methods.filter((m): m is string => typeof m === "string"),
      );
      this.serverFeatures.events = new Set(
        events.filter((e): e is string => typeof e === "string"),
      );
    }
    const policy = obj["policy"];
    if (policy && typeof policy === "object") {
      const interval = (policy as Record<string, unknown>)["tickIntervalMs"];
      if (typeof interval === "number" && interval > 0) {
        this.tickIntervalMs = interval;
      }
    }
    this.log(
      "info",
      `connected: ${this.serverFeatures.methods.size} methods, ${this.serverFeatures.events.size} events, tick=${this.tickIntervalMs}ms`,
    );
  }

  private dispatchFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const obj = frame as Record<string, unknown>;
    const type = obj["type"];

    if (type === "res") {
      const id = obj["id"] as string | undefined;
      if (!id) return;
      const p = this.pending.get(id);
      if (!p) {
        this.log("debug", `response for unknown id ${id}`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(p.timeout);
      if (obj["ok"] === true) {
        p.resolve(obj["payload"]);
      } else {
        const err = obj["error"] as Record<string, unknown> | undefined;
        p.reject(
          new Error(
            `gateway error [${p.method}]: ${String(err?.["code"])} ${String(err?.["message"])}`,
          ),
        );
      }
      return;
    }

    if (type === "event") {
      const event = obj["event"];
      if (typeof event !== "string") return;
      this.handleEvent(event, obj["payload"], obj);
      return;
    }

    this.log("debug", `unknown frame type ${String(type)}`);
  }

  private handleEvent(name: string, payload: unknown, envelope: Record<string, unknown>): void {
    if (name === "tick") {
      this.armTickWatchdog();
      return;
    }
    if (name === "chat") {
      const msg = decodeChatEvent(payload, envelope);
      if (msg === null) {
        this.log("warn", "chat event with unrecognized payload; dropping");
        return;
      }
      if (this.inboundHandler) {
        try {
          this.inboundHandler(msg);
        } catch (err) {
          this.log("error", `inboundHandler threw: ${String(err)}`);
        }
      }
      return;
    }
    // shutdown/heartbeat/presence/etc. — log + ignore for now.
    this.log("debug", `event ${name} (unhandled)`);
  }

  private armTickWatchdog(): void {
    if (this.tickWatchdog) clearTimeout(this.tickWatchdog);
    this.tickWatchdog = setTimeout(() => {
      this.log("warn", "tick timeout — closing with 4000");
      const ws = this.ws;
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.close(CLOSE_TICK_TIMEOUT, "tick timeout");
        } catch {
          // ignore invalid-code throws
        }
      }
    }, this.tickIntervalMs * 2);
  }

  private clearChallengeTimer(): void {
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearChallengeTimer();
    if (this.tickWatchdog) {
      clearTimeout(this.tickWatchdog);
      this.tickWatchdog = null;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      try {
        p.reject(err);
      } catch {
        // handler may throw; don't propagate.
      }
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)] ?? 16_000;
    this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_MS.length - 1);
    this.log("info", `reconnecting in ${delay}ms (backoff step ${this.backoffIndex})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.log("error", `reconnect failed: ${String(err)}`);
      });
    }, delay);
  }

  private resolveToken(): string | null {
    if (this.explicitToken !== undefined) return this.explicitToken;
    const envToken = process.env["OPENCLAW_GATEWAY_TOKEN"];
    if (envToken && envToken.length > 0) return envToken;
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const gw = parsed["gateway"] as Record<string, unknown> | undefined;
      const auth = gw?.["auth"] as Record<string, unknown> | undefined;
      const token = auth?.["token"];
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch (err) {
      this.log("warn", `token lookup from ${this.configPath} failed: ${String(err)}`);
      return null;
    }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Permissive decoder: tries multiple field names since exact payload shape varies.
export function decodeChatEvent(
  payload: unknown,
  envelope: Record<string, unknown>,
): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const channel =
    pickString(p, "channel") ?? pickString(p, "source") ?? pickString(p, "platform") ?? "unknown";

  const userId =
    pickString(p, "senderId") ??
    pickString(p, "sender") ??
    pickString(p, "from") ??
    pickString(p, "userId") ??
    null;
  if (userId === null) return null;

  const text = pickString(p, "text") ?? pickString(p, "body") ?? pickString(p, "message") ?? "";

  const conversationId =
    pickString(p, "conversationId") ?? pickString(p, "chatId") ?? pickString(p, "threadId") ?? null;

  const envelopeId =
    pickString(p, "envelopeId") ??
    pickString(p, "id") ??
    pickString(envelope, "id") ??
    randomUUID();

  const receivedAt =
    pickNumber(p, "receivedAt") ?? pickNumber(p, "ts") ?? pickNumber(p, "timestamp") ?? Date.now();

  return {
    envelopeId,
    channel,
    userId,
    conversationId,
    text,
    receivedAt,
    raw: p,
  };
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function defaultLog(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [openclaw-adapter] ${level.toUpperCase()} ${msg}\n`);
}
