import type { IncomingMessage, ServerResponse } from "node:http";
import { ethers } from "ethers";
import { registerWebApi, getHealth } from "./health";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const linkNonces = new Map<string, { nonce: string; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1_000;

export type ActiveWalletRef = { kind: "agent" } | { kind: "external"; address: string };

/**
 * Generic dependencies — concrete implementations are injected from src/index.ts
 * so this module stays inside the shared rootDir (no upward imports).
 */
export type WebApiDeps = {
  getProfile: (email: string) => Record<string, unknown> | null;
  getPositions: (email: string) => unknown[];
  getRecentTrades: (email: string, limit: number) => unknown[];
  connectExternalWallet: (email: string, address: string, label: string) => boolean;
  setActiveWallet: (email: string, ref: ActiveWalletRef) => boolean;
};

export function startWebApi(deps: WebApiDeps): void {
  registerWebApi(async (req, res, url) => {
    if (!url.pathname.startsWith("/api/")) return false;

    if (url.pathname === "/api/agents/health" && req.method === "GET") {
      sendJson(res, 200, getHealth());
      return true;
    }

    if (url.pathname === "/api/profile" && req.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) return (sendJson(res, 400, { error: "email required" }), true);
      const cfg = deps.getProfile(email);
      if (!cfg) return (sendJson(res, 404, { error: "user not found" }), true);
      sendJson(res, 200, cfg);
      return true;
    }

    if (url.pathname === "/api/positions" && req.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) return (sendJson(res, 400, { error: "email required" }), true);
      const positions = deps.getPositions(email);
      const recentTrades = deps.getRecentTrades(email, 20);
      sendJson(res, 200, { positions, recentTrades });
      return true;
    }

    if (url.pathname === "/api/link-wallet/nonce" && req.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) return (sendJson(res, 400, { error: "email required" }), true);
      const nonce = generateNonce();
      linkNonces.set(email, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
      sendJson(res, 200, { nonce, message: linkMessage(email, nonce) });
      return true;
    }

    if (url.pathname === "/api/link-wallet" && req.method === "POST") {
      const body = await readJson(req);
      const email = String(body["email"] ?? "");
      const address = String(body["address"] ?? "");
      const signature = String(body["signature"] ?? "");
      const label = body["label"] ? String(body["label"]) : undefined;

      if (!email || !address || !signature) {
        return (sendJson(res, 400, { error: "email, address, signature required" }), true);
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return (sendJson(res, 400, { error: "invalid address" }), true);
      }
      const nonceEntry = linkNonces.get(email);
      if (!nonceEntry || nonceEntry.expiresAt < Date.now()) {
        return (sendJson(res, 400, { error: "nonce expired or missing" }), true);
      }
      const expectedMessage = linkMessage(email, nonceEntry.nonce);
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(expectedMessage, signature);
      } catch {
        return (sendJson(res, 400, { error: "signature verification failed" }), true);
      }
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return (sendJson(res, 401, { error: "signature does not match address" }), true);
      }
      linkNonces.delete(email);
      const labelArg = label ?? `external-${address.slice(0, 6)}`;
      const ok = deps.connectExternalWallet(email, address, labelArg);
      if (!ok) return (sendJson(res, 400, { error: "could not connect wallet" }), true);
      const cfg = deps.getProfile(email);
      sendJson(res, 200, { ok: true, profile: cfg });
      return true;
    }

    if (url.pathname === "/api/active-wallet" && req.method === "POST") {
      const body = await readJson(req);
      const email = String(body["email"] ?? "");
      const kind = body["kind"];
      const address = body["address"] ? String(body["address"]) : undefined;

      if (!email) return (sendJson(res, 400, { error: "email required" }), true);
      if (kind !== "agent" && kind !== "external") {
        return (sendJson(res, 400, { error: "kind must be 'agent' or 'external'" }), true);
      }
      if (kind === "external" && !address) {
        return (sendJson(res, 400, { error: "address required for external wallet" }), true);
      }
      const ref: ActiveWalletRef =
        kind === "agent" ? { kind: "agent" } : { kind: "external", address: address! };
      const ok = deps.setActiveWallet(email, ref);
      if (!ok) return (sendJson(res, 400, { error: "could not set active wallet" }), true);
      const cfg = deps.getProfile(email);
      sendJson(res, 200, { ok: true, profile: cfg });
      return true;
    }

    return false;
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
      throw new Error("body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function generateNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function linkMessage(email: string, nonce: string): string {
  return [
    "HAWKEYE — link external wallet",
    "",
    `Account: ${email}`,
    `Nonce: ${nonce}`,
    "",
    "Sign this message to bind this wallet to your HAWKEYE account.",
    "This signature is off-chain only and does not authorize any trade.",
  ].join("\n");
}
