import { EventEmitter } from "node:events";
import type { BusEvents } from "./types";

export type EventMap = Record<string, unknown>;

export type Handler<P> = (payload: P) => void;

export class EventBus<E extends EventMap> {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(32);
  }

  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.emitter.on(event, handler as (payload: unknown) => void);
  }

  off<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.emitter.off(event, handler as (payload: unknown) => void);
  }

  once<K extends keyof E & string>(event: K, handler: Handler<E[K]>): void {
    this.emitter.once(event, handler as (payload: unknown) => void);
  }

  listenerCount<K extends keyof E & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners<K extends keyof E & string>(event?: K): void {
    if (event === undefined) this.emitter.removeAllListeners();
    else this.emitter.removeAllListeners(event);
  }
}

export const bus = new EventBus<BusEvents>();

export default bus;
