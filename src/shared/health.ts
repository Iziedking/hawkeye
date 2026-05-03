import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { log } from "./logger";

export type SubsystemStatus = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type WebApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean> | boolean;

const apiHandlers: WebApiHandler[] = [];

export function registerWebApi(handler: WebApiHandler): void {
  apiHandlers.push(handler);
}

export type HealthReport = {
  status: "ok" | "degraded" | "down";
  uptime: number;
  subsystems: SubsystemStatus[];
  agents: string[];
  openPositions: number;
  busDepth: number;
};

type HealthCheck = () => SubsystemStatus;

const checks: HealthCheck[] = [];
const bootTime = Date.now();

let agentList: string[] = [];
let openPositionCount = 0;
let busEventCount = 0;

export function registerHealthCheck(check: HealthCheck): void {
  checks.push(check);
}

export function setAgentList(agents: string[]): void {
  agentList = agents;
}

export function setOpenPositions(count: number): void {
  openPositionCount = count;
}

export function incrementBusEvents(): void {
  busEventCount++;
}

export function getHealth(): HealthReport {
  const subsystems = checks.map((c) => c());
  const allOk = subsystems.every((s) => s.ok);
  const anyOk = subsystems.some((s) => s.ok);

  return {
    status: allOk ? "ok" : anyOk ? "degraded" : "down",
    uptime: Date.now() - bootTime,
    subsystems,
    agents: agentList,
    openPositions: openPositionCount,
    busDepth: busEventCount,
  };
}

// Map health check names to sponsor-facing display names and detail labels
const SPONSOR_DISPLAY: Record<string, { label: string; detailMap: (detail?: string) => string }> = {
  LLM: {
    label: "0G Compute",
    detailMap: (d) => (d === "0G Compute" ? "qwen-2.5-7b" : (d ?? "")),
  },
  "0G Storage": {
    label: "0G Storage",
    detailMap: (d) => (d === "active" ? "testnet" : (d ?? "")),
  },
  "0G Registry": {
    label: "0G Chain",
    detailMap: (d) => d ?? "",
  },
  "Gensyn AXL": {
    label: "Gensyn AXL",
    detailMap: (d) => d ?? "",
  },
  KeeperHub: {
    label: "KeeperHub",
    detailMap: (d) => (d === "active" ? "MEV protection" : (d ?? "")),
  },
  Wallets: {
    label: "Privy",
    detailMap: (d) => (d === "Privy" ? "agent wallets" : (d ?? "")),
  },
};

export function formatHealthForTelegram(): string {
  const h = getHealth();
  const totalMin = Math.floor(h.uptime / 60_000);
  let uptimeStr: string;
  if (totalMin >= 60) {
    const hrs = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    uptimeStr = `${hrs}h ${mins}m`;
  } else {
    uptimeStr = `${totalMin}m`;
  }

  const lines = [
    "HAWKEYE Status",
    "",
    `Uptime: ${uptimeStr} | ${h.agents.length} agents | ${h.busDepth} events`,
    "",
  ];

  // Uniswap is not a health-checked subsystem; it is always available
  // when the Execution Agent is running. Show it after the subsystems.
  const uniswapOk = h.agents.includes("Execution");

  for (const s of h.subsystems) {
    const display = SPONSOR_DISPLAY[s.name];
    const label = display ? display.label : s.name;
    const detail = display ? display.detailMap(s.detail) : (s.detail ?? "");
    const status = s.ok ? "ON" : "OFF";
    const tag = s.ok ? "✓" : "✗";
    const pad = " ".repeat(Math.max(1, 14 - label.length));
    lines.push(`${tag} ${label}${pad}${status}   ${detail}`);
  }

  // Uniswap line (derived from Execution Agent presence)
  {
    const tag = uniswapOk ? "✓" : "✗";
    const status = uniswapOk ? "ON" : "OFF";
    const label = "Uniswap";
    const pad = " ".repeat(Math.max(1, 14 - label.length));
    lines.push(`${tag} ${label}${pad}${status}   Trading API`);
  }

  return lines.join("\n");
}

let server: Server | null = null;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startHealthServer(port = 8080): Server {
  server = createServer(async (req, res) => {
    // CORS preflight — answer everything.
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      const report = getHealth();
      const status = report.status === "down" ? 503 : 200;
      res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }

    // Try registered API handlers in order; first one to claim wins.
    for (const handler of apiHandlers) {
      try {
        const handled = await handler(req, res, url);
        if (handled) return;
      } catch (err) {
        console.error("[web-api] handler error:", (err as Error).message);
        if (!res.headersSent) {
          res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
        return;
      }
    }

    res.writeHead(404, CORS_HEADERS);
    res.end();
  });

  server.listen(port, () => {
    log.boot(`health endpoint on :${port}/health`);
  });

  return server;
}

export function stopHealthServer(): void {
  server?.close();
}
