#!/usr/bin/env node
// Reads GoPlus credentials from .env.local and spawns goplus-mcp with them.
// The CLI only accepts --key/--secret as args, so this launcher bridges env vars to args.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const envPath = resolve(repoRoot, ".env.local");

function loadEnvLocal() {
  if (!existsSync(envPath)) {
    process.stderr.write(
      `goplus-launcher: .env.local not found at ${envPath}. Create it with GOPLUS_API_KEY and GOPLUS_API_SECRET.\n`,
    );
    process.exit(2);
  }
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
    // Don't clobber vars already set in the real environment — real env wins.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

const key = process.env.GOPLUS_API_KEY;
const secret = process.env.GOPLUS_API_SECRET;
if (!key || !secret) {
  process.stderr.write(
    "goplus-launcher: GOPLUS_API_KEY and GOPLUS_API_SECRET must both be set (check .env.local).\n",
  );
  process.exit(2);
}

const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npxBin, ["-y", "goplus-mcp@latest", "--key", key, "--secret", secret], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", (err) => {
  process.stderr.write(`goplus-launcher: spawn error: ${err.message}\n`);
  process.exit(1);
});
