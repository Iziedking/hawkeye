# HAWKEYE

Autonomous crypto trading agent swarm. Talk to it on Telegram in plain English — _"ape this 0xabc... with 0.1 ETH"_, _"is this token safe?"_, _"swap ETH to USDC on Base"_ — and a network of specialised agents collaborates to research, vet, price, execute, and monitor the trade.

Built for the **0G APAC Hackathon, Track 2: Agentic Trading Arena**. Submission deadline **2026-05-03**.

## Architecture

Every message hits an LLM router that classifies it into one of 10 intent categories, then a typed event bus fans the work out to specialised agents that run in parallel.

```
┌──────────────────────┐
│   Telegram (grammY)  │  user types in plain English
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│     LLM Router       │  0G Compute (primary) → Claude (fallback) → regex
│  10 intent classes   │  bare-CA degen shortcut bypasses LLM (<1ms)
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Typed Event Bus                           │
│   TRADE_REQUEST · RESEARCH_REQUEST · ALPHA_FOUND · …         │
└──┬────────────┬────────────┬────────────┬───────────┬────────┘
   ▼            ▼            ▼            ▼           ▼
┌──────┐   ┌───────┐   ┌──────────┐   ┌──────────┐  ┌─────────┐
│Safety│   │ Quote │   │ Strategy │   │Execution │  │ Monitor │
│agent │   │ agent │   │  agent   │   │  agent   │  │  agent  │
└──┬───┘   └───┬───┘   └────┬─────┘   └────┬─────┘  └────┬────┘
   │           │            │              │             │
GoPlus      DexScreener   risk +        KeeperHub    DexScreener
Honeypot    Uniswap       confirm       Privy        polling
                          rules         signing      → EXECUTE_SELL

  ┌──────────┐     ┌────────────┐
  │ Research │     │ Copy Trade │
  │  agent   │     │   agent    │
  └────┬─────┘     └─────┬──────┘
       │                 │
   alpha scan        wallet watch
   → ALPHA_FOUND     → TRADE_REQUEST
```

### Latency budget (degen flow)

```
0ms     LLM router → DEGEN_SNIPE → TRADE_REQUEST
0ms     Safety + Quote agents start in parallel
~1.0s   QUOTE_RESULT
~1.5s   SAFETY_RESULT
~1.6s   STRATEGY_DECISION (EXECUTE)
~2.5s   tx submitted via KeeperHub
~5.0s   confirmed on chain → TRADE_EXECUTED
~5.1s   user sees entry price + tx hash; Monitor starts watching
```

## Repo layout

```
src/
├── index.ts                     # boot: env check, LLM, Privy, gateway, tracer
├── shared/
│   ├── event-bus.ts             # typed EventEmitter wrapper
│   ├── types.ts                 # all bus events + domain types
│   ├── env.ts                   # .env.local loader + validation
│   ├── store.ts                 # atomic JSON wallet store
│   ├── tokens.ts                # symbol → address resolver
│   └── swarm-tracer.ts          # parallel-execution timing logs
├── gateway/
│   ├── telegram-gateway.ts      # primary UX (grammY)
│   └── llm-router.ts            # intent classification
├── integrations/
│   ├── 0g/{compute,storage}.ts  # Galileo testnet inference + audit trail
│   ├── claude/                  # Anthropic SDK fallback LLM
│   ├── privy/                   # per-user agent wallets
│   └── gensyn/axl-src/          # Go P2P node (future bus transport)
├── tools/                       # MCP servers
│   ├── dexscreener-mcp/
│   ├── openclaw-docs-mcp/
│   ├── gensyn-axl-mcp/
│   └── goplus-mcp-launcher.mjs
└── agents/                      # ← teammate PRs land here
```

The `src/agents/` directory is where the seven specialised agents (Safety, Quote, Strategy, Research, Execution, Monitor, Copy Trade) get wired in. Owners and signatures are in [`PLAN.md`](PLAN.md).

## Quick start

```bash
# 1. Install
npm ci

# 2. Configure
cp .env.example .env.local
# fill in TELEGRAM_BOT_TOKEN and HAWKEYE_EVM_PRIVATE_KEY (required)
# fill in ANTHROPIC_API_KEY and PRIVY_APP_ID/SECRET (recommended)

# 3. Run
npm start
```

The bot will fail loudly if any required env var is missing, and will print warnings for recommended ones (degraded mode is allowed for development).

## Scripts

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm start`            | Boot the bot with `tsx` (no compile step) |
| `npm run build`        | Compile TypeScript to `dist/`             |
| `npm run typecheck`    | `tsc --noEmit`, no output                 |
| `npm test`             | Run all `*.smoke-test.ts` files in series |
| `npm run lint`         | ESLint over the whole repo                |
| `npm run lint:fix`     | ESLint with autofix                       |
| `npm run format`       | Prettier write                            |
| `npm run format:check` | Prettier check (CI uses this)             |

## Required env

| Variable                                        | Purpose                     | Required?   |
| ----------------------------------------------- | --------------------------- | ----------- |
| `TELEGRAM_BOT_TOKEN`                            | grammY bot login            | Required    |
| `HAWKEYE_EVM_PRIVATE_KEY`                       | 0G Compute + Storage wallet | Required    |
| `ANTHROPIC_API_KEY`                             | Claude fallback LLM         | Recommended |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET`             | Per-user agent wallets      | Recommended |
| `OG_RPC_URL`, `OG_MODEL`, `OG_PROVIDER_ADDRESS` | 0G overrides                | Optional    |
| `CLAUDE_MODEL`                                  | Override Claude model       | Optional    |
| `UNISWAP_API_KEY`                               | Quote fallback              | Optional    |
| `GOPLUS_API_KEY` / `GOPLUS_API_SECRET`          | Safety scans                | Optional    |
| `KH_API_KEY`                                    | KeeperHub MEV protection    | Optional    |

## Sponsor integrations

| Sponsor        | Used for                                       | Status                           |
| -------------- | ---------------------------------------------- | -------------------------------- |
| **0G Compute** | Primary LLM router + agent reasoning           | Live on Galileo testnet          |
| **0G Storage** | On-chain audit trail for parsed intents        | Live on Galileo testnet          |
| **0G Chain**   | Mainnet contract (submission requirement)      | Pending deploy                   |
| **Gensyn AXL** | P2P transport for the bus                      | Node + MCP wired, not active     |
| **KeeperHub**  | EVM tx submission with MEV protection          | MCP wired                        |
| **Uniswap**    | DEX integration (Trading API)                  | Used in Quote + Execution agents |
| **Privy**      | Per-user agent wallets, signing, tx submission | Live in Telegram gateway         |

## Contributing

Teammates building agents should read [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

1. Branch: `feat/<your-name>-<feature>`
2. Code goes in `src/agents/<agent-name>/index.ts`
3. Export a start function that subscribes to bus events and returns a cleanup
4. Smoke-test locally
5. Open a PR into `main`

## Status

Infrastructure (event bus, LLM router, Telegram gateway, wallets, MCP servers, sponsor integrations) is **shipped**. Trading agents are **pending PRs** — see [`PLAN.md`](PLAN.md) for owners and current status.

## License

ISC
