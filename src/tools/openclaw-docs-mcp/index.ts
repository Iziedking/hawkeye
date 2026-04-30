#!/usr/bin/env node
// OpenClaw documentation MCP server. Search and fetch docs from openclaws.io
// and the official GitHub repo.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchDoc, FetchError } from "./fetch.js";
import { searchDocs } from "./search.js";
import { CURATED_INDEX, ALLOWED_ORIGIN_PREFIXES } from "./sources.js";

const server = new McpServer(
  { name: "openclaw-docs-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Search and fetch OpenClaw documentation. Use search_openclaw_docs to find relevant pages by keyword, then fetch_openclaw_page to retrieve the full markdown. The authoritative source is the openclaw/openclaw GitHub README; openclaws.io is a community-maintained mirror.",
  },
);

server.registerTool(
  "search_openclaw_docs",
  {
    title: "Search OpenClaw docs",
    description:
      "Keyword search across a curated index of OpenClaw pages plus the full AI-facing corpus at openclaws.io/llms-full.txt. Returns ranked hits with URL, title, snippet, and score. Prefer authoritative=true hits (GitHub README) when they appear.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms, e.g. 'gateway configuration json5'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("Max number of hits to return. Default 10."),
      includeLlmsFull: z
        .boolean()
        .optional()
        .describe(
          "Include full-text search over llms-full.txt. Default true. Set false for curated-only fast lookups.",
        ),
    },
  },
  async (args) => {
    const hits = await searchDocs(args.query, {
      limit: args.limit ?? 10,
      includeLlmsFull: args.includeLlmsFull ?? true,
    });

    if (hits.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No matches for "${args.query}". Try broader terms or call list_openclaw_sources to see what's curated.`,
          },
        ],
      };
    }

    const lines = hits.map((h, i) => {
      const mark = h.authoritative ? " [authoritative]" : "";
      return `${i + 1}. ${h.title}${mark}\n   ${h.url}\n   source=${h.source} score=${h.score}\n   ${h.snippet}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  },
);

server.registerTool(
  "fetch_openclaw_page",
  {
    title: "Fetch an OpenClaw page",
    description:
      "Fetch a single OpenClaw documentation page by full URL or site-relative path. HTML is converted to markdown; .txt/.md/raw files pass through as-is. URL must start with one of: " +
      ALLOWED_ORIGIN_PREFIXES.join(", "),
    inputSchema: {
      url: z
        .string()
        .min(1)
        .describe(
          "Absolute URL (must match the allow-list) or site-relative path like '/docs/cli' which resolves against openclaws.io.",
        ),
      bypassCache: z
        .boolean()
        .optional()
        .describe("Skip the 10-minute in-memory cache. Default false."),
    },
  },
  async (args) => {
    try {
      const result = await fetchDoc(args.url, {
        bypassCache: args.bypassCache ?? false,
      });
      const header = `# ${result.url}\n\nstatus: ${result.status}\ncontent-type: ${result.contentType}\ncache: ${result.fromCache ? "hit" : "miss"}\n\n---\n\n`;
      return {
        content: [{ type: "text", text: header + result.markdown }],
      };
    } catch (err) {
      if (err instanceof FetchError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Fetch failed: ${err.message}`,
            },
          ],
        };
      }
      throw err;
    }
  },
);

server.registerTool(
  "list_openclaw_sources",
  {
    title: "List curated OpenClaw doc sources",
    description:
      "Returns the built-in curated index of OpenClaw pages with titles, URLs, tags, and which are authoritative. Use this to discover what's available without issuing a search.",
    inputSchema: {},
  },
  async () => {
    const lines = CURATED_INDEX.map((e) => {
      const mark = e.authoritative ? " [authoritative]" : "";
      return `- ${e.title}${mark}\n  ${e.url}\n  tags: ${e.tags.join(", ")}\n  ${e.summary}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Allowed origins: ${ALLOWED_ORIGIN_PREFIXES.join(", ")}\n\nCurated sources (${CURATED_INDEX.length}):\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("openclaw-docs-mcp ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `openclaw-docs-mcp fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
