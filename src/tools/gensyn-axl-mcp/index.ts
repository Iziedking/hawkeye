#!/usr/bin/env node
// Gensyn AXL MCP server. Wraps the local AXL node HTTP API at 127.0.0.1:9002.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AXL_API = process.env["AXL_API_URL"] ?? "http://127.0.0.1:9002";

async function axlFetch(path: string, opts?: RequestInit): Promise<Response> {
  const url = `${AXL_API}${path}`;
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  return res;
}

function respondJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function respondError(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

const PEER_ID_SCHEMA = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "peer_id must be a 64-char hex ed25519 public key");

const server = new McpServer(
  { name: "gensyn-axl-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Interact with the Gensyn AXL P2P network. Use get_topology to discover peers. " +
      "Use send_message / recv_message for raw P2P data. Use mcp_proxy to call a remote " +
      "peer's MCP service, and a2a_proxy for A2A JSON-RPC calls.",
  },
);

server.tool(
  "get_topology",
  "Returns this node's IPv6 address, public key, connected peers, and tree state",
  {},
  async () => {
    try {
      const res = await axlFetch("/topology");
      return respondJson(await res.json());
    } catch (err) {
      return respondError(err);
    }
  },
);

server.tool(
  "send_message",
  "Send raw binary data to a remote peer (fire-and-forget)",
  {
    peer_id: PEER_ID_SCHEMA.describe("Destination peer's hex public key (64 chars)"),
    data: z.string().describe("Message data to send (will be sent as UTF-8 bytes)"),
  },
  async ({ peer_id, data }) => {
    try {
      const res = await axlFetch("/send", {
        method: "POST",
        headers: {
          "X-Destination-Peer-Id": peer_id,
          "Content-Type": "application/octet-stream",
        },
        body: data,
      });
      const sentBytes = res.headers.get("X-Sent-Bytes") ?? "unknown";
      return respondJson({ status: res.status, sentBytes });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.tool(
  "recv_message",
  "Poll for the next inbound message from any peer",
  {},
  async () => {
    try {
      const res = await axlFetch("/recv");
      if (res.status === 204) {
        return respondJson({ status: 204, message: "No messages in queue" });
      }
      const fromPeer = res.headers.get("X-From-Peer-Id") ?? "unknown";
      const body = await res.text();
      return respondJson({ status: 200, from: fromPeer, data: body });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.tool(
  "mcp_proxy",
  "Send a JSON-RPC request to a remote peer's MCP service via the AXL network",
  {
    peer_id: PEER_ID_SCHEMA.describe("Remote peer's hex public key (64 chars)"),
    service: z.string().describe("MCP service name on the remote peer (e.g. 'weather')"),
    method: z.string().describe("JSON-RPC method (e.g. 'tools/list', 'tools/call')"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON-RPC params object"),
  },
  async ({ peer_id, service, method, params }) => {
    try {
      const body = {
        jsonrpc: "2.0",
        method,
        id: 1,
        params: params ?? {},
      };
      const res = await axlFetch(`/mcp/${peer_id}/${service}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return respondJson(await res.json());
    } catch (err) {
      return respondError(err);
    }
  },
);

server.tool(
  "a2a_proxy",
  "Send a JSON-RPC request to a remote peer's A2A server via the AXL network",
  {
    peer_id: PEER_ID_SCHEMA.describe("Remote peer's hex public key (64 chars)"),
    service: z.string().describe("MCP service name to target in the A2A payload"),
    method: z.string().describe("Inner MCP method (e.g. 'tools/list', 'tools/call')"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Inner MCP params object"),
    message_id: z
      .string()
      .optional()
      .describe("Client-assigned correlation ID (defaults to random)"),
  },
  async ({ peer_id, service, method, params, message_id }) => {
    try {
      const innerRequest = {
        service,
        request: {
          jsonrpc: "2.0",
          method,
          id: 1,
          params: params ?? {},
        },
      };
      const body = {
        jsonrpc: "2.0",
        method: "SendMessage",
        id: 1,
        params: {
          message: {
            role: "ROLE_USER",
            parts: [{ text: JSON.stringify(innerRequest) }],
            messageId: message_id ?? crypto.randomUUID(),
          },
        },
      };
      const res = await axlFetch(`/a2a/${peer_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return respondJson(await res.json());
    } catch (err) {
      return respondError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`gensyn-axl-mcp fatal: ${err}\n`);
  process.exit(1);
});
