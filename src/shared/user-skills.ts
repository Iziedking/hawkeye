import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const PATH = resolve(process.cwd(), "data", "skill-overrides.json");

type Store = Record<string, Record<string, boolean>>;

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (!existsSync(PATH)) {
    cache = {};
    return cache;
  }
  try {
    const raw = readFileSync(PATH, "utf-8");
    cache = JSON.parse(raw) as Store;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn(`[user-skills] persist failed: ${(err as Error).message}`);
  }
}

export function getUserSkillOverrides(userId: string): Record<string, boolean> {
  const s = load();
  return s[userId] ?? {};
}

export function setUserSkillOverride(userId: string, skillId: string, enabled: boolean): void {
  const s = load();
  if (!s[userId]) s[userId] = {};
  s[userId]![skillId] = enabled;
  persist();
}

export function clearUserSkillOverride(userId: string, skillId: string): void {
  const s = load();
  if (!s[userId]) return;
  delete s[userId]![skillId];
  persist();
}
