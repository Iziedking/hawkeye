# Contributing

## Setup

```bash
git clone <repo-url> && cd hawkeye
npm install
cp .env.example .env.local   # fill in your keys
```

## Project Structure

```
src/
  shared/           types, event bus, env loader
  agents/           one folder per agent, talks only via event bus
  gateway/          OpenClaw adapter, LLM router, bus wiring
  integrations/     sponsor SDK wrappers (0g/, gensyn/, keeperhub/)
  tools/            MCP servers
```

## Event Bus

All agents talk through a typed event bus. No agent imports another directly. You listen for events, do your work, and emit the result.

```
User message -> Gateway -> LLM Router
                              |
              +---------------+---------------+------------------+
              |               |               |                  |
        DEGEN_SNIPE/     RESEARCH_TOKEN   GENERAL_QUERY      BRIDGE/PORTFOLIO/
        TRADE                |            UNKNOWN             COPY_TRADE/etc.
              |               |               |                  |
        TRADE_REQUEST    RESEARCH_REQUEST  2nd LLM call     "coming soon"
              |                            (conversational)    + bus event
              |
    +---------+---------+
    |                   |
Safety Agent       Quote Agent
    |                   |
SAFETY_RESULT      QUOTE_RESULT
    |                   |
    +---------+---------+
              |
       Strategy Agent
              |
       EXECUTE_TRADE
              |
      Execution Agent
              |
      TRADE_EXECUTED
              |
      Monitor Agent
```

### Events

| Event | Emitter | Listener |
|-------|---------|----------|
| TRADE_REQUEST | Gateway (DEGEN_SNIPE/TRADE) | Safety, Quote |
| SAFETY_RESULT | Safety | Strategy, Gateway |
| QUOTE_RESULT | Quote | Strategy |
| STRATEGY_DECISION | Strategy | Gateway |
| EXECUTE_TRADE | Strategy | Execution |
| TRADE_EXECUTED | Execution | Monitor, Gateway |
| EXECUTE_SELL | Monitor | Execution |
| ALPHA_FOUND | Research | Gateway |
| COPY_TRADE_REQUEST | Gateway (COPY_TRADE) / Copy Trade Agent | Safety pipeline |
| POSITION_UPDATE | Monitor | Gateway |
| RESEARCH_REQUEST | Gateway (RESEARCH_TOKEN) | Research Agent |
| RESEARCH_RESULT | Research Agent | Gateway |
| GENERAL_QUERY_REQUEST | Gateway (GENERAL_QUERY) | (future agents) |
| GENERAL_QUERY_RESULT | Gateway (inline 0G call) | (future agents) |

### Writing an Agent

```typescript
import { bus } from "../shared/event-bus";
import type { TradeIntent, SafetyReport } from "../shared/types";

export function startSafetyAgent() {
  bus.on("TRADE_REQUEST", async (intent: TradeIntent) => {
    const report = await runParallelSafetyScan(intent);
    bus.emit("SAFETY_RESULT", report);
  });
}
```

Import types from `src/shared/types.ts`. Talk only through the bus. Each agent gets its own folder under `src/agents/`.

## MCP Tools

These are pre-wired in `.mcp.json` and work after `npm install`.

| MCP | What it does | Who needs it |
|-----|-------------|--------------|
| dexscreener | DEX pair and token data, 7 tools | Quote, Research, Safety |
| goplus | Token security scanning, 7 tools | Safety |
| coingecko | Market data, OHLC, exchanges, 50 tools | Quote, Research |
| openclaw-docs | OpenClaw documentation search | Gateway dev |
| gensyn-axl | P2P messaging and topology | Bus transport |
| keeperhub | EVM execution and gas management | Execution |

Uniswap AI skills are in `.agents/skills/` for swap and liquidity guidance.

### Gensyn AXL Node

Only needed if you're working on the P2P bus transport. Rebuild from source:

```bash
cd src/integrations/gensyn/axl-src
GOTOOLCHAIN=go1.25.5 go build -o node ./cmd/node
openssl genpkey -algorithm ed25519 -out private.pem
./node -config node-config.json
```

## Development

Typecheck per subtree (root tsc will fail, that's expected):

```bash
npx tsc -p src/shared/tsconfig.json --noEmit
npx tsc -p src/gateway/tsconfig.json --noEmit
```

Run smoke tests:

```bash
npx tsx src/gateway/smoke-test.ts
npx tsx src/gateway/llm-router.smoke-test.ts
npx tsx src/gateway/intent-parser.smoke-test.ts
npx tsx src/tools/dexscreener-mcp/smoke-test.ts
npx tsx src/tools/gensyn-axl-mcp/smoke-test.ts
```

## Rules

Read these before writing any code. They were figured out the hard way.

- LLM Router never calls DexScreener or GoPlus. It returns `chain: "evm" | "solana"` only. Sub-chain resolution is the Quote and Safety Agent's job.
- Always resolve chains through DexScreener first. Never hardcode chain IDs.
- Amounts are always `{ value, unit }`, never bare numbers. `0.5 ETH` is `{ value: 0.5, unit: "NATIVE" }`.
- DexScreener search only works with a single word. Strip extra tokens client-side.
- Monitor Agent emits EXECUTE_SELL but never executes the sell itself. Execution Agent handles on-chain.
- MEV protection is always on. Flashbots and KeeperHub for EVM, Jito for Solana.
- Honeypot.is is EVM-only. Use RugCheck for Solana tokens.

## Branches

Work on `feat/<your-name>-<feature>`. Open a PR into main. Israel reviews and merges. Do not push to main directly. Smoke tests must pass before merge.
