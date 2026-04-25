#!/usr/bin/env node
// DexScreener MCP server. Wraps the public API with single-word search
// stripping, client-side chain filter, and suspicious liquidity warnings.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DEXSCREENER_CHAINS,
  DexScreenerError,
  getLatestBoosts,
  getLatestTokenProfiles,
  getPair,
  getPairsByToken,
  getTokens,
  getTopBoosts,
  isValidChain,
  searchPairs,
} from "./client.js";

const server = new McpServer(
  { name: "dexscreener-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Query the DexScreener public API for on-chain DEX pair and token data. Use search_dex_pairs for discovery (single-word search — any multi-word query is stripped). Use get_pairs_by_token for a specific token's pairs on a known chain. Chain must be one of: " +
      DEXSCREENER_CHAINS.join(", "),
  },
);

const chainSchema = z
  .string()
  .refine(isValidChain, {
    message: `chain must be one of: ${DEXSCREENER_CHAINS.join(", ")}`,
  })
  .describe(
    "DexScreener chain id (e.g. 'ethereum', 'bsc', 'base', 'solana'). Resolved DexScreener-first per LESSONS.md — do not hardcode numeric chain ids.",
  );

function respondJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
    ],
  };
}

function respondError(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const msg =
    err instanceof DexScreenerError
      ? `DexScreener error${err.status ? ` (HTTP ${err.status})` : ""} on ${err.endpoint ?? "?"}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

server.registerTool(
  "search_dex_pairs",
  {
    title: "Search DEX pairs on DexScreener",
    description:
      "Keyword search for DEX pairs. DexScreener's search is single-word — any multi-word query is stripped to the first meaningful word and the stripping is reported in the response. Optional chain filter is applied client-side (the underlying API ignores chain). Flags pairs with liquidity > $500M as likely bad data per LESSONS.md.",
    inputSchema: {
      query: z.string().min(1).describe("Search term, e.g. a token symbol or name."),
      chain: chainSchema.optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Max pairs to return after filtering. Default 30."),
    },
  },
  async (args) => {
    try {
      const opts: { chain?: (typeof DEXSCREENER_CHAINS)[number]; limit?: number } = {};
      if (args.chain && isValidChain(args.chain)) opts.chain = args.chain;
      if (args.limit !== undefined) opts.limit = args.limit;
      const result = await searchPairs(args.query, opts);
      return respondJson(result);
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_pairs_by_token",
  {
    title: "Get all DEX pairs for a token",
    description:
      "Returns every DexScreener-indexed pair for a given token address on a given chain. Use this after resolving the chain via search (LESSONS.md DexScreener-first pattern).",
    inputSchema: {
      chain: chainSchema,
      tokenAddress: z
        .string()
        .min(1)
        .describe(
          "Token contract address (0x… for EVM, base58 for Solana). Case-sensitive on Solana.",
        ),
    },
  },
  async (args) => {
    try {
      if (!isValidChain(args.chain)) {
        return respondError(new Error(`invalid chain: ${args.chain}`));
      }
      const pairs = await getPairsByToken(args.chain, args.tokenAddress);
      return respondJson({ chain: args.chain, tokenAddress: args.tokenAddress, count: pairs.length, pairs });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_pair",
  {
    title: "Get a single DEX pair",
    description:
      "Fetch full details for a specific pair by (chain, pairAddress).",
    inputSchema: {
      chain: chainSchema,
      pairAddress: z.string().min(1).describe("DEX pair / pool address."),
    },
  },
  async (args) => {
    try {
      if (!isValidChain(args.chain)) {
        return respondError(new Error(`invalid chain: ${args.chain}`));
      }
      const pair = await getPair(args.chain, args.pairAddress);
      if (!pair) {
        return {
          content: [
            {
              type: "text",
              text: `No pair found on ${args.chain} at ${args.pairAddress}.`,
            },
          ],
        };
      }
      return respondJson(pair);
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_tokens",
  {
    title: "Bulk-lookup tokens on a chain",
    description:
      "Fetch DexScreener pair data for up to 30 token addresses on a single chain in one request.",
    inputSchema: {
      chain: chainSchema,
      tokenAddresses: z
        .array(z.string().min(1))
        .min(1)
        .max(30)
        .describe("Up to 30 token addresses on the given chain."),
    },
  },
  async (args) => {
    try {
      if (!isValidChain(args.chain)) {
        return respondError(new Error(`invalid chain: ${args.chain}`));
      }
      const pairs = await getTokens(args.chain, args.tokenAddresses);
      return respondJson({ chain: args.chain, count: pairs.length, pairs });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_latest_token_profiles",
  {
    title: "Latest token profiles (discovery feed)",
    description:
      "Returns the most recent token profiles listed on DexScreener across all chains. Useful for Research Agent discovery runs.",
    inputSchema: {},
  },
  async () => {
    try {
      const profiles = await getLatestTokenProfiles();
      return respondJson({ count: profiles.length, profiles });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_latest_boosts",
  {
    title: "Latest paid boosts",
    description:
      "Tokens recently boosted on DexScreener. Note: boosts are paid promotion, not an endorsement — use only as one signal among many.",
    inputSchema: {},
  },
  async () => {
    try {
      const boosts = await getLatestBoosts();
      return respondJson({ count: boosts.length, boosts });
    } catch (err) {
      return respondError(err);
    }
  },
);

server.registerTool(
  "get_top_boosts",
  {
    title: "Top paid boosts",
    description:
      "Tokens with the highest cumulative boosts on DexScreener. Same caveat as get_latest_boosts.",
    inputSchema: {},
  },
  async () => {
    try {
      const boosts = await getTopBoosts();
      return respondJson({ count: boosts.length, boosts });
    } catch (err) {
      return respondError(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("dexscreener-mcp ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `dexscreener-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
