
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadEnvLocal(): void {
  if (loaded) return;
  loaded = true;

  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  loadEnvLocal();
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `Missing required env var: ${name}. Set it in .env.local at repo root.`,
    );
  }
  return v;
}

export function envOr(name: string, fallback: string): string {
  loadEnvLocal();
  return process.env[name] ?? fallback;
}
