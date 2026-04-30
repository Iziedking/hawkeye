import { createServer, type Server } from "node:http";

export type SubsystemStatus = {
  name: string;
  ok: boolean;
  detail?: string;
};

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

export function formatHealthForTelegram(): string {
  const h = getHealth();
  const uptimeMin = Math.floor(h.uptime / 60_000);
  const lines = [
    `HAWKEYE ${h.status.toUpperCase()}`,
    `Uptime: ${uptimeMin}m`,
    `Agents: ${h.agents.length} online`,
    `Positions: ${h.openPositions} open`,
    `Bus events: ${h.busDepth}`,
    "",
  ];

  for (const s of h.subsystems) {
    lines.push(`${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? ` (${s.detail})` : ""}`);
  }

  return lines.join("\n");
}

let server: Server | null = null;

export function startHealthServer(port = 8080): Server {
  server = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const report = getHealth();
      const status = report.status === "down" ? 503 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`[health] HTTP endpoint on :${port}/health`);
  });

  return server;
}

export function stopHealthServer(): void {
  server?.close();
}
