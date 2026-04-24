// DexScreener MCP smoke test. Spawns server, runs init + tools/list + search.
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
  "src/tools/dexscreener-mcp/index.ts",
);
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
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const r = pending.get(msg.id)!;
          pending.delete(msg.id);
          r(msg);
        }
      } catch {
        // ignore non-JSON
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
        reject(new Error(`Timeout on ${method}. Stderr:\n${stderrBuf.slice(0, 400)}`));
      }, 30000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(frame);
    });
  }
  function notify(method: string, params?: unknown): void {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
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
    const tools = (listResp.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "get_latest_boosts",
      "get_latest_token_profiles",
      "get_pair",
      "get_pairs_by_token",
      "get_tokens",
      "get_top_boosts",
      "search_dex_pairs",
    ];
    record(
      "tools/list",
      JSON.stringify(names) === JSON.stringify(expected),
      `got=${JSON.stringify(names)}`,
    );

    // Single-word invariant: "pepe coin ethereum" must be stripped to "pepe".
    const searchResp = await request("tools/call", {
      name: "search_dex_pairs",
      arguments: { query: "pepe coin ethereum", chain: "ethereum", limit: 3 },
    });
    const searchText =
      (searchResp.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const searchOk =
      searchText.includes('"query": "pepe"') &&
      searchText.includes('"strippedFrom"') &&
      searchText.toLowerCase().includes('"chainid": "ethereum"');
    record(
      "search_dex_pairs (strips multi-word, filters chain)",
      searchOk,
      `len=${searchText.length}`,
    );

    // get_pairs_by_token for WETH on ethereum.
    const wethResp = await request("tools/call", {
      name: "get_pairs_by_token",
      arguments: { chain: "ethereum", tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    });
    const wethText =
      (wethResp.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const wethOk = !(wethResp.result as { isError?: boolean })?.isError && wethText.includes('"pairs"');
    record("get_pairs_by_token (WETH)", wethOk, `len=${wethText.length}`);
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
