/**
 * Persistent chat-route store.
 *
 * Maps user email → Telegram chat coordinates so async notifications
 * (wallet-funded alerts, position pings) can find the user across process
 * restarts. Without this, `chatByEmail` is only populated for users who have
 * messaged the bot since the last boot, and a restart silently drops the
 * route until the next interaction.
 *
 * The file is small and only written when a route is new or has changed —
 * not on every message — so the disk cost stays negligible.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const FILE_PATH = resolve(DATA_DIR, "chats.json");

export type ChatRoute = {
  chatId: number;
  telegramId: string;
  updatedAt: number;
};

type ChatStoreFile = Record<string, ChatRoute>;

let cache: ChatStoreFile = {};

export function loadChats(): void {
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    cache = JSON.parse(raw) as ChatStoreFile;
    console.log(`[chat-store] loaded ${Object.keys(cache).length} chat route(s)`);
  } catch {
    cache = {};
  }
}

function flush(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Atomic write: tmp file + rename so a crash mid-write can't truncate
    // the live file.
    const tmp = `${FILE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tmp, FILE_PATH);
  } catch (err) {
    console.warn(`[chat-store] flush failed: ${(err as Error).message}`);
  }
}

export function getAllChats(): ReadonlyMap<string, ChatRoute> {
  return new Map(Object.entries(cache));
}

export function getChat(email: string): ChatRoute | undefined {
  return cache[email];
}

/**
 * Record a chat route. Returns true if anything actually changed (new route
 * or different chatId/telegramId), so the caller can decide whether to
 * persist. We don't write to disk on every message — only on first sight or
 * a real change.
 */
export function rememberChatRoute(email: string, chatId: number, telegramId: string): boolean {
  const existing = cache[email];
  if (existing && existing.chatId === chatId && existing.telegramId === telegramId) {
    return false;
  }
  cache[email] = { chatId, telegramId, updatedAt: Date.now() };
  flush();
  return true;
}
