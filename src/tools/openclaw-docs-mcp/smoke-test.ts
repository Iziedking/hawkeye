// OpenClaw docs MCP smoke test. Exercises tools/list + all 3 tools.
import { spawn } from "node:child_process";
import * as path from "node:path";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const serverEntry = path.resolve(
  process.cwd(),
  "src/tools/openclaw-docs-mcp/index.ts",
);

// Pin tsx from node_modules/.bin rather than relying on PATH, so we fail
// loudly if the dep is missing instead of silently running a stale global.
const tsxBin = path.resolve(
  process.cwd(),
  "node_modules/.bin/tsx" + (process.platform === "win32" ? ".cmd" : ""),
);

async function run(): Promise<void> {
  const child = spawn(tsxBin, [serverEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32",
  });

  let stderrBuf = "";
  child.stderr.on("data", (c) => {
    stderrBuf += c.toString();
  });

  const pending = new Map<number, (m: JsonRpcMessage) => void>();
  let lineBuf = "";
  child.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const resolver = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  let nextId = 1;
  function request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}. Stderr:\n${stderrBuf}`));
      }, 30000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(frame);
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  function record(name: string, ok: boolean, detail: string): void {
    results.push({ name, ok, detail });
    process.stderr.write(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}\n`);
  }

  try {
    const initResp = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    });
    record(
      "initialize",
      !initResp.error,
      initResp.error
        ? JSON.stringify(initResp.error)
        : `server=${JSON.stringify((initResp.result as { serverInfo?: unknown })?.serverInfo)}`,
    );
    notify("notifications/initialized");

    const listResp = await request("tools/list");
    const tools = (listResp.result as { tools?: Array<{ name: string }> })
      ?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "fetch_openclaw_page",
      "list_openclaw_sources",
      "search_openclaw_docs",
    ];
    record(
      "tools/list",
      JSON.stringify(names) === JSON.stringify(expected),
      `got=${JSON.stringify(names)}`,
    );

    const listSources = await request("tools/call", {
      name: "list_openclaw_sources",
      arguments: {},
    });
    const listText =
      (listSources.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text ?? "";
    record(
      "list_openclaw_sources",
      listText.includes("Official OpenClaw README"),
      `len=${listText.length}`,
    );

    const searchResp = await request("tools/call", {
      name: "search_openclaw_docs",
      arguments: { query: "gateway configuration", includeLlmsFull: false, limit: 5 },
    });
    const searchText =
      (searchResp.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text ?? "";
    record(
      "search_openclaw_docs (curated-only)",
      searchText.toLowerCase().includes("gateway"),
      `len=${searchText.length}`,
    );

    const fetchResp = await request("tools/call", {
      name: "fetch_openclaw_page",
      arguments: { url: "https://openclaws.io/llms.txt" },
    });
    const fetchText =
      (fetchResp.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text ?? "";
    const isErr = (fetchResp.result as { isError?: boolean })?.isError;
    record(
      "fetch_openclaw_page(llms.txt)",
      !isErr && fetchText.length > 200,
      `isError=${isErr} len=${fetchText.length}`,
    );
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  process.stderr.write(
    `\nSummary: ${results.length - failed.length}/${results.length} passed\n`,
  );
  if (stderrBuf.trim()) {
    process.stderr.write(`\n--- server stderr ---\n${stderrBuf}\n`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  process.stderr.write(
    `smoke-test fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
