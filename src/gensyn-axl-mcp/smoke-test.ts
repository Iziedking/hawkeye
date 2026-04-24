// Gensyn AXL MCP smoke test. Requires AXL node running at 127.0.0.1:9002.
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
  "src/tools/gensyn-axl-mcp/index.ts",
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
  child.stderr.on("data", (c: Buffer) => {
    stderrBuf += c.toString();
  });

  const pending = new Map<number, (m: JsonRpcMessage) => void>();
  let lineBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
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
      }, 15000);
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
    // 1. Initialize
    const initResp = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });
    record(
      "initialize",
      !initResp.error,
      initResp.error
        ? JSON.stringify(initResp.error)
        : `server=${JSON.stringify((initResp.result as { serverInfo?: unknown })?.serverInfo)}`,
    );
    notify("notifications/initialized");

    // 2. tools/list
    const listResp = await request("tools/list");
    const tools = (listResp.result as { tools?: Array<{ name: string }> })
      ?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "a2a_proxy",
      "get_topology",
      "mcp_proxy",
      "recv_message",
      "send_message",
    ];
    record(
      "tools/list",
      JSON.stringify(names) === JSON.stringify(expected),
      `got=${JSON.stringify(names)}`,
    );

    // 3. Call get_topology (requires live AXL node)
    const topoResp = await request("tools/call", {
      name: "get_topology",
      arguments: {},
    });
    const topoText =
      (topoResp.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text ?? "";
    let topoOk = false;
    try {
      const topo = JSON.parse(topoText);
      topoOk =
        typeof topo.our_public_key === "string" &&
        typeof topo.our_ipv6 === "string" &&
        Array.isArray(topo.peers);
      record(
        "get_topology",
        topoOk,
        `key=${topo.our_public_key?.slice(0, 12)}... peers=${topo.peers?.length}`,
      );
    } catch {
      record("get_topology", false, `parse error, text=${topoText.slice(0, 80)}`);
    }

    // 4. Call recv_message (expect 204 empty queue)
    const recvResp = await request("tools/call", {
      name: "recv_message",
      arguments: {},
    });
    const recvText =
      (recvResp.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text ?? "";
    try {
      const recv = JSON.parse(recvText);
      record(
        "recv_message",
        recv.status === 204 || recv.status === 200,
        `status=${recv.status}`,
      );
    } catch {
      record("recv_message", false, `parse error, text=${recvText.slice(0, 80)}`);
    }
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
