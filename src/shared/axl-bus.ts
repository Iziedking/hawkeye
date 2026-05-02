// Gensyn AXL P2P bus transport. Same EventBus interface, but events are
// broadcast to all connected AXL peers in addition to local handlers.
// Agents don't know or care which transport is in use.
//
// Requires AXL node running at AXL_API_URL (default http://127.0.0.1:9002).
// Falls back to local-only EventEmitter if the node is unreachable.

import { EventEmitter } from "node:events";
import type { EventMap, Handler } from "./event-bus";
import { log } from "./logger";

const AXL_API = process.env["AXL_API_URL"] ?? "http://127.0.0.1:9002";
const POLL_INTERVAL_MS = 100;
const AXL_TIMEOUT_MS = 5_000;

type AxlMessage<E extends EventMap> = {
  type: "hawkeye_bus";
  event: keyof E & string;
  payload: unknown;
  nodeId: string;
  ts: number;
};

export class AxlEventBus<E extends EventMap> {
  private readonly local = new EventEmitter();
  private nodeId: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private peerIds: string[] = [];

  constructor() {
    this.local.setMaxListeners(64);
    this.nodeId = `hawkeye-${Date.now().toString(36)}`;
  }

  async start(): Promise<void> {
    try {
      const res = await fetch(`${AXL_API}/topology`, {
        signal: AbortSignal.timeout(AXL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`topology returned ${res.status}`);
      const topo = (await res.json()) as {
        public_key?: string;
        peers?: Array<{ public_key?: string }>;
      };
      this.nodeId = topo.public_key ?? this.nodeId;
      this.peerIds = (topo.peers ?? []).map((p) => p.public_key ?? "").filter((k) => k.length > 0);
      this.connected = true;
      this.startPolling();
      log.gensyn(`connected node=${this.nodeId.slice(0, 12)}... peers=${this.peerIds.length}`);
    } catch (err) {
      log.warn(`AXL node unreachable at ${AXL_API}: ${(err as Error).message}`);
      this.connected = false;
    }
  }

  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    this.local.emit(event, payload);

    if (this.connected && this.peerIds.length > 0) {
      const msg: AxlMessage<E> = {
        type: "hawkeye_bus",
        event,
        payload,
        nodeId: this.nodeId,
        ts: Date.now(),
      };
      const body = JSON.stringify(msg);
      for (const peerId of this.peerIds) {
        fetch(`${AXL_API}/send`, {
          method: "POST",
          headers: {
            "X-Destination-Peer-Id": peerId,
            "Content-Type": "application/octet-stream",
          },
          body,
          signal: AbortSignal.timeout(AXL_TIMEOUT_MS),
        }).catch((err) =>
          console.error(`[axl-bus] send to ${peerId.slice(0, 12)}... failed:`, err),
        );
      }
    }
  }

  on<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.local.on(event, handler as (payload: unknown) => void);
  }

  off<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.local.off(event, handler as (payload: unknown) => void);
  }

  once<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.local.once(event, handler as (payload: unknown) => void);
  }

  listenerCount<K extends keyof E & string>(event: K): number {
    return this.local.listenerCount(event);
  }

  removeAllListeners<K extends keyof E & string>(event?: K): void {
    if (event === undefined) this.local.removeAllListeners();
    else this.local.removeAllListeners(event);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPeerCount(): number {
    return this.peerIds.length;
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }

  async refreshPeers(): Promise<void> {
    if (!this.connected) return;
    try {
      const res = await fetch(`${AXL_API}/topology`, {
        signal: AbortSignal.timeout(AXL_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const topo = (await res.json()) as {
        peers?: Array<{ public_key?: string }>;
      };
      this.peerIds = (topo.peers ?? []).map((p) => p.public_key ?? "").filter((k) => k.length > 0);
    } catch {
      // topology refresh is best-effort
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    let refreshCounter = 0;

    this.pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${AXL_API}/recv`, {
          signal: AbortSignal.timeout(AXL_TIMEOUT_MS),
        });
        if (res.status === 204) return;

        const body = await res.text();
        let msg: AxlMessage<E>;
        try {
          msg = JSON.parse(body) as AxlMessage<E>;
        } catch {
          return;
        }

        if (msg.type !== "hawkeye_bus") return;
        if (msg.nodeId === this.nodeId) return;

        this.local.emit(msg.event, msg.payload);
      } catch {
        // recv poll failure is transient
      }

      refreshCounter++;
      if (refreshCounter % 100 === 0) {
        void this.refreshPeers();
      }
    }, POLL_INTERVAL_MS);
  }
}
