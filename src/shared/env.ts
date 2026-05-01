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
    throw new Error(`Missing required env var: ${name}. Set it in .env.local at repo root.`);
  }
  return v;
}

export function envOr(name: string, fallback: string): string {
  loadEnvLocal();
  return process.env[name] ?? fallback;
}

/**
 * Snapshot of which env-driven subsystems are configured. Used at startup so
 * we can fail fast on missing required vars and warn loudly about degraded modes.
 */
export type EnvCheck = {
  required: { name: string; ok: boolean }[];
  recommended: { name: string; ok: boolean; degrades: string }[];
  optional: { name: string; ok: boolean; enables: string }[];
};

export function validateEnv(): EnvCheck {
  loadEnvLocal();
  const has = (name: string): boolean => {
    const v = process.env[name];
    return v !== undefined && v !== "";
  };

  return {
    required: [
      { name: "TELEGRAM_BOT_TOKEN", ok: has("TELEGRAM_BOT_TOKEN") },
      { name: "HAWKEYE_EVM_PRIVATE_KEY", ok: has("HAWKEYE_EVM_PRIVATE_KEY") },
    ],
    recommended: [
      {
        name: "OPENROUTER_API_KEY or ANTHROPIC_API_KEY",
        ok: has("OPENROUTER_API_KEY") || has("ANTHROPIC_API_KEY"),
        degrades: "no LLM fallback — 0G Compute outages drop to regex-only routing",
      },
      {
        name: "PRIVY_APP_ID/PRIVY_APP_SECRET",
        ok: has("PRIVY_APP_ID") && has("PRIVY_APP_SECRET"),
        degrades: "agent wallets disabled — users must connect external wallets",
      },
    ],
    optional: [
      {
        name: "UNISWAP_API_KEY",
        ok: has("UNISWAP_API_KEY"),
        enables: "Uniswap Trading API quote fallback",
      },
      {
        name: "GOPLUS_API_KEY",
        ok: has("GOPLUS_API_KEY"),
        enables: "GoPlus token safety scanning",
      },
      { name: "KH_API_KEY", ok: has("KH_API_KEY"), enables: "KeeperHub MEV-protected execution" },
      {
        name: "HAWKEYE_MASTER_KEY",
        ok: has("HAWKEYE_MASTER_KEY"),
        enables: "encrypted wallet store (AES-256-GCM)",
      },
    ],
  };
}

/**
 * Throws if any required env var is missing. Returns warnings (one per
 * missing recommended var) for the caller to print.
 */
export function assertRequiredEnv(check?: EnvCheck): string[] {
  const c = check ?? validateEnv();
  const missing = c.required.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and fill them in.`,
    );
  }
  return c.recommended.filter((r) => !r.ok).map((r) => `${r.name} not set — ${r.degrades}`);
}
