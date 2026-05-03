# HAWKEYE

Autonomous crypto trading agent swarm on Telegram. Seven specialized agents
coordinate through a typed event bus to handle the full trade lifecycle: safety
checks, quoting, strategy, execution, monitoring, research, and copy trading.

Built for the **Open Agent Hackathon**. Powered by **0G Compute** (LLM),
**0G Storage** (audit trail), and **0G Chain** (on-chain registry), with
**Gensyn AXL** for P2P swarm transport, **KeeperHub** for MEV protection,
**Uniswap** for routing, and **Privy** for per-user wallets.

---

## Table of contents

- [Architecture](#architecture)
- [How a trade flows](#how-a-trade-flows)
- [The seven agents](#the-seven-agents)
- [Event bus contract](#event-bus-contract)
- [LLM fallback chain](#llm-fallback-chain)
- [0G integration](#0g-integration)
- [Sponsor integrations](#sponsor-integrations)
- [Project layout](#project-layout)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Commands](#commands)
- [Telegram commands](#telegram-commands)
- [Development workflow](#development-workflow)
- [On-chain deployments](#on-chain-deployments)
- [Status and known limitations](#status-and-known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture

```
                                    Telegram (grammY)
                                          │
                                          ▼
                          ┌────────────────────────────────┐
                          │       Telegram Gateway         │
                          │  • wallet provisioning (Privy) │
                          │  • inline confirmations        │
                          │  • multi-chain balance checks  │
                          │  • degen shortcut (bare 0x...) │
                          └─────────────────┬──────────────┘
                                            │
                                            ▼
                          ┌────────────────────────────────┐
                          │           LLM Router           │
                          │   0G Compute → OpenRouter →    │
                          │      Claude → regex-only       │
                          └─────────────────┬──────────────┘
                                            │
        ┌────────────────┬──────────────────┼───────────────────┬─────────────┐
        ▼                ▼                  ▼                   ▼             ▼
  DEGEN_SNIPE      RESEARCH_TOKEN     GENERAL_QUERY        COPY_TRADE     PORTFOLIO
   / TRADE              │                  │                   │           BRIDGE
        │               ▼                  ▼                   ▼          SETTINGS
        │         Research Agent    LLM conversational   Copy Trade Agent     │
        │     ┌──────┴──────┐         response             (DexScreener      LLM
        │   DexScreener  Arkham                            WebSocket)        reply
        │   DeFiLlama    Nansen
        │   CoinGecko    Birdeye
        │   GoPlus       Tavily/RSS
        ▼
  TRADE_REQUEST  ──────────────►  Bus
        │
   ┌────┴────┐
   ▼         ▼
 Safety    Quote
 Agent     Agent
   │         │
   │   GoPlus, Honeypot.is, RugCheck, Jupiter list,
   │   DexScreener, Etherscan/Solscan, CoinGecko
   │         │
   ▼         ▼
 SAFETY    QUOTE
 _RESULT   _RESULT
        │
        ▼
 Strategy Agent  ── INSTANT / NORMAL / CAREFUL gating
        │
        ▼
 EXECUTE_TRADE
        │
        ▼
 Execution Agent  ── Uniswap Trade API · KeeperHub MEV · Permit2 · Privy signing
        │
        ▼
 TRADE_EXECUTED ──► 0G Audit Trail (Storage rootHash + Chain logTrade)
        │
        ▼
 Monitor Agent    ── 5 s price polling · trailing stops · partial exits
        │
        └─► EXECUTE_SELL  ──►  Execution Agent
```

A bare contract address pasted in Telegram skips the LLM entirely and reaches
the bus in under 1 ms via the gateway's degen shortcut.

---

## How a trade flows

```
  0 ms    LLM Router classifies intent → TRADE_REQUEST emitted
  0 ms    Safety + Quote start in parallel
  0 ms    0G Audit Trail writes intent to Storage and storeIntent() on Chain
~1.5 s    SAFETY_RESULT (GoPlus + Honeypot.is + RugCheck merged with weighted scoring)
  ~1 s    QUOTE_RESULT (DexScreener pair + slippage + fee estimate)
~1.6 s    Strategy Agent merges both, applies mode rules, emits EXECUTE_TRADE
~2.5 s    Execution submits via Uniswap Trade API (Permit2-aware)
          ─ mainnet routes through KeeperHub for MEV protection
~5.0 s    Transaction confirmed on chain
~5.1 s    Monitor starts polling DexScreener every 5 s, evaluating exit targets
          ─ partial exits emit EXECUTE_SELL back to Execution
```

---

## The seven agents

| Agent          | Listens                                                                            | Emits                                | Responsibility                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Safety**     | `TRADE_REQUEST`, `COPY_TRADE_REQUEST`                                              | `SAFETY_RESULT`                      | Multi-source token risk scoring (GoPlus, Honeypot, RugCheck, Jupiter list); 5-min cache; weighted source-reliability scoring |
| **Quote**      | `TRADE_REQUEST`                                                                    | `QUOTE_RESULT`, `QUOTE_FAILED`       | Pair discovery, price/liquidity, expected slippage, fee estimate                                                             |
| **Strategy**   | `TRADE_REQUEST`, `SAFETY_RESULT`, `QUOTE_RESULT`, `QUOTE_FAILED`, `USER_CONFIRMED` | `STRATEGY_DECISION`, `EXECUTE_TRADE` | Mode-aware merge of safety + quote (`INSTANT`/`NORMAL`/`CAREFUL`); 10 s merge timeout; 60 s user-confirm timeout             |
| **Execution**  | `EXECUTE_TRADE`, `EXECUTE_SELL`                                                    | `TRADE_EXECUTED`, `QUOTE_FAILED`     | Uniswap Trade API 3-step flow (`check_approval`, `quote`, `swap`); KeeperHub for mainnet MEV; Permit2 signing                |
| **Monitor**    | `TRADE_EXECUTED`, `EXECUTE_SELL`                                                   | `EXECUTE_SELL`, `POSITION_UPDATE`    | 5 s price polling per position; trailing-stop and multiplier exits; emits sells but never executes                           |
| **Research**   | `RESEARCH_REQUEST`                                                                 | `RESEARCH_RESULT`, `ALPHA_FOUND`     | Token analysis and trending discovery from DexScreener, DeFiLlama, CoinGecko, Arkham, Nansen, Birdeye, Etherscan             |
| **Copy Trade** | `ADD_WATCHED_WALLET`, `REMOVE_WATCHED_WALLET`                                      | `COPY_TRADE_REQUEST`                 | DexScreener WebSocket wallet watch; tx-hash + pair-window dedup (15 s); buys-only mirror                                     |

All agents talk **exclusively** through the bus — no agent imports another
directly. The bus is local `EventEmitter` by default; when `AXL_API_URL` is set,
the same events are bridged peer-to-peer through Gensyn AXL for cross-node
swarms.

---

## Event bus contract

Every event payload is typed in `src/shared/types.ts` (the `BusEvents` map).
Adding a new agent means: define the payload type, add it to `BusEvents`, and
listen/emit through the shared `bus` singleton.

| Event                   | Emitter                    | Listener                       |
| ----------------------- | -------------------------- | ------------------------------ |
| `TRADE_REQUEST`         | Gateway, Copy Trade        | Safety, Quote, Audit Trail     |
| `SAFETY_RESULT`         | Safety                     | Strategy, Audit Trail, Gateway |
| `QUOTE_RESULT`          | Quote                      | Strategy, Execution            |
| `QUOTE_FAILED`          | Quote, Execution           | Strategy, Gateway              |
| `STRATEGY_DECISION`     | Strategy                   | Gateway, Audit Trail           |
| `EXECUTE_TRADE`         | Strategy                   | Execution                      |
| `TRADE_EXECUTED`        | Execution                  | Monitor, Gateway, Audit Trail  |
| `EXECUTE_SELL`          | Monitor                    | Execution                      |
| `POSITION_UPDATE`       | Monitor                    | Gateway                        |
| `COPY_TRADE_REQUEST`    | Gateway, Copy Trade        | Safety pipeline                |
| `ADD_WATCHED_WALLET`    | Gateway                    | Copy Trade                     |
| `REMOVE_WATCHED_WALLET` | Gateway                    | Copy Trade                     |
| `RESEARCH_REQUEST`      | Gateway                    | Research                       |
| `RESEARCH_RESULT`       | Research                   | Gateway, Audit Trail           |
| `ALPHA_FOUND`           | Research (background loop) | Audit Trail                    |
| `GENERAL_QUERY_REQUEST` | Gateway                    | (future agents)                |
| `GENERAL_QUERY_RESULT`  | Gateway (inline LLM)       | (future agents)                |
| `USER_CONFIRMED`        | Gateway (inline keyboard)  | Strategy                       |

Events bridged across AXL P2P are listed in `bridgedEvents` in
`src/index.ts`. A `forwarding` flag breaks re-emit loops between local and
remote transports.

---

## LLM fallback chain

The LLM Router and several agents share a single `FallbackLlmClient`
(`src/integrations/claude/index.ts`) that wraps three tiers:

1. **0G Compute** — primary, on-chain verifiable inference via the 0G Serving
   Broker; uses `processResponse()` to verify TEE attestation receipts when
   available.
2. **OpenRouter** — configurable model via `OPENROUTER_MODEL`
   (default `google/gemini-2.0-flash-001`). Used when 0G Compute is unhealthy.
3. **Claude** (`ANTHROPIC_API_KEY`) — secondary fallback, only when 0G and
   OpenRouter are both unavailable.
4. **Regex-only** — last resort. Bare-address degen snipes still work, intent
   classification degrades to keyword heuristics.

Once a session falls back, it stays on the fallback for the rest of that
process — no periodic re-probing of 0G.

---

## 0G integration

HAWKEYE uses three 0G components, all funded from the same
`HAWKEYE_EVM_PRIVATE_KEY`.

### 0G Compute (`src/integrations/0g/compute.ts`)

LLM brain. Classifies every user message into intent categories, powers
conversational responses, and drives Strategy/Research analysis. Verified
inference via `processResponse()`. Includes ledger-balance preflight and
nonce-serialized broker calls.

### 0G Storage (`src/integrations/0g/storage.ts`, `audit-trail.ts`)

Immutable audit trail. Writes at six lifecycle points, each returning a
`rootHash`:

1. `TRADE_REQUEST` — intent payload
2. `SAFETY_RESULT` — safety report (cached locally for the matching
   `TRADE_EXECUTED` log)
3. `STRATEGY_DECISION` — execute/reject/await reason
4. `TRADE_EXECUTED` — receipt with tx hash
5. `RESEARCH_RESULT` — synthesis
6. `ALPHA_FOUND` — background discovery

Writes are queued sequentially and protected by a circuit breaker (3 failures →
5-minute open), so a slow indexer never blocks the trade path.

### 0G Chain (`src/integrations/0g/registry-client.ts`, `contracts/HawkeyeRegistry.sol`)

`HawkeyeRegistry` is a Solidity contract that records agent identities and
trade execution proofs:

- `registerAgent(name, role)` — onlyOwner; stores agent metadata.
- `storeIntent(intentId, data)` — emits intent on every `TRADE_REQUEST`.
- `logTrade(intentId, token, chain, safetyScore, decision)` — appended on
  every `TRADE_EXECUTED`.
- View: `getAgentCount()`, `getTradeCount()`, `getActiveAgents()`.

Chain writes use a separate sequential queue from Storage writes so neither
blocks the other.

---

## Integrations

| Sponsor        | Used for                                               | Path                                                 |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| **0G**         | Compute (LLM), Storage (audit), Chain (registry)       | `src/integrations/0g/`                               |
| **Gensyn AXL** | P2P bus transport between agent nodes                  | `src/shared/axl-bus.ts`, `src/tools/gensyn-axl-mcp/` |
| **KeeperHub**  | MEV-protected EVM tx submission, with circuit breaker  | `src/integrations/keeperhub/`                        |
| **Uniswap**    | Quote + swap routing (3-step flow over 17+ EVM chains) | `src/agents/execution/`                              |
| **Privy**      | Per-user agent wallets, email login, signing           | `src/integrations/privy/`                            |
| **Arkham**     | Token holders, fund flows, entity intel for Research   | `src/integrations/arkham/`                           |
| **Nansen**     | Smart-money flow data (10-min in-memory cache)         | `src/integrations/nansen/`                           |

Anthropic Claude and OpenRouter are not sponsors; they are LLM fallbacks for
when 0G Compute is unavailable.

---

## Project layout

```
src/
  index.ts                         main startup, dependency wiring, cleanup
  shared/                          cross-cutting utilities
    event-bus.ts                   typed local EventEmitter
    axl-bus.ts                     Gensyn AXL P2P transport
    types.ts                       BusEvents + every payload type
    env.ts                         .env loader with required/optional checks
    constants.ts                   safety thresholds, timeouts, TTLs
    evm-chains.ts                  16-chain RPC + token metadata
    tokens.ts                      symbol → address resolver
    store.ts                       AES-256-GCM encrypted wallet store
    swarm-tracer.ts                bus-event latency tracing
    health.ts                      HTTP health server + agent registry
    logger.ts                      ANSI logger with sponsor status
  gateway/
    telegram-gateway.ts            primary user surface (grammY)
    llm-router.ts                  intent classifier (11 categories)
    openclaw-adapter.ts            alternative WebSocket gateway (reference)
  agents/
    safety/                        token risk analysis
    quote/                         price discovery and routing
    strategy/                      trade decision engine
    execution/                     on-chain swap execution
    monitor/                       position tracking and exit triggers
    research/                      token analysis and alpha scanning
    copy-trade/                    wallet watching
  integrations/
    0g/                            Compute, Storage, Registry, audit trail
    openrouter/                    OpenRouter LLM client
    claude/                        Claude LLM + FallbackLlmClient
    privy/                         per-user agent wallets
    keeperhub/                     MEV-protected tx submission
    arkham/                        on-chain entity intel
    nansen/                        smart-money flows
  tools/                           MCP servers
    dexscreener-mcp/               7-tool DEX data MCP
    gensyn-axl-mcp/                P2P topology + messaging
    openclaw-docs-mcp/             docs search MCP
    goplus-mcp-launcher.mjs        bridges .env to goplus-mcp@latest
contracts/
  HawkeyeRegistry.sol              on-chain agent registry + trade proofs
scripts/
  deploy-registry.ts               contract deployment
  run-smoke-tests.mjs              walks src/ and runs every *.smoke-test.ts
.agents/skills/                    Uniswap AI swap-planning skills
```

---

## Setup

```bash
git clone <repo-url> && cd hawkeye
npm install
cp .env.example .env.local       # fill in required vars (see below)
npm start                         # launches Telegram bot
```

Node 22+ recommended (the OpenClaw adapter relies on the global `WebSocket`
implementation that landed in Node 22).

---

## Environment variables

| Variable                               | Purpose                                                  | Required    |
| -------------------------------------- | -------------------------------------------------------- | ----------- |
| `TELEGRAM_BOT_TOKEN`                   | Telegram bot via @BotFather                              | Yes         |
| `HAWKEYE_EVM_PRIVATE_KEY`              | Funds 0G Compute, Storage, Chain                         | Yes         |
| `OPENROUTER_API_KEY`                   | LLM fallback (any model via `OPENROUTER_MODEL`)          | Recommended |
| `ANTHROPIC_API_KEY`                    | Claude fallback (used after OpenRouter)                  | Recommended |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET`    | Per-user agent wallets                                   | Recommended |
| `OG_PROVIDER_ADDRESS`                  | 0G Compute provider (defaults to Galileo)                | Optional    |
| `OG_MODEL`                             | 0G inference model (default `qwen/qwen-2.5-7b-instruct`) | Optional    |
| `HAWKEYE_REGISTRY_ADDRESS`             | Deployed registry contract address                       | Optional    |
| `UNISWAP_API_KEY`                      | Swap routing                                             | Optional    |
| `GOPLUS_API_KEY` / `GOPLUS_API_SECRET` | Token safety scanning                                    | Optional    |
| `KH_API_KEY`                           | KeeperHub MEV protection                                 | Optional    |
| `KH_WALLET_ADDRESS`                    | KeeperHub Turnkey wallet address (auto-fetched if unset) | Optional    |
| `DUNE_API_KEY`                         | Smart-money flow data                                    | Optional    |
| `ETHERSCAN_API_KEY`                    | Holder concentration, contract age                       | Optional    |
| `ARKHAM_API_KEY`                       | Arkham entity intel for Research                         | Optional    |
| `NANSEN_API_KEY`                       | Smart-money flows for Research                           | Optional    |
| `BIRDEYE_API_KEY`                      | Solana token data                                        | Optional    |
| `BRAVE_API_KEY` / `TAVILY_API_KEY`     | Trend/news signal for Research                           | Optional    |
| `AXL_API_URL`                          | Local Gensyn AXL node (e.g. `http://127.0.0.1:9002`)     | Optional    |
| `HAWKEYE_MASTER_KEY`                   | AES-256-GCM key for wallet store at rest                 | Optional    |
| `HEALTH_PORT`                          | HTTP health server (default 8080)                        | Optional    |

See `.env.example` for the full list with descriptions and chain RPC overrides.

---

## Commands

| Script                 | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm start`            | Run the bot via `tsx src/index.ts`                   |
| `npm run typecheck`    | Per-subtree `tsc --noEmit` across all scoped configs |
| `npm test`             | Run every `*.smoke-test.ts` under `src/` (in series) |
| `npm run lint`         | ESLint                                               |
| `npm run lint:fix`     | ESLint with auto-fix                                 |
| `npm run format`       | Prettier write                                       |
| `npm run format:check` | Prettier check                                       |

Run a single smoke test directly:

```bash
npx tsx src/gateway/llm-router.smoke-test.ts
```

---

## Telegram commands

| Command    | What it does                             |
| ---------- | ---------------------------------------- |
| `/start`   | Welcome message and setup                |
| `/wallet`  | Create or view agent wallet              |
| `/balance` | Native balances across configured chains |
| `/status`  | System health and agent status           |
| `/help`    | Full command guide                       |

Paste any contract address to trigger an instant trade flow. Natural-language
queries like _"What's trending on Ethereum?"_ are routed through the LLM to
the appropriate agent.

---

## Development workflow

The repo uses **per-subtree tsconfigs** because the gateway, agents, and each
integration have different TypeScript settings (e.g. `verbatimModuleSyntax`
relaxed for agents). The root `tsc` is **not** expected to pass — always
typecheck through scoped configs:

```bash
npx tsc -p src/shared/tsconfig.json --noEmit
npx tsc -p src/gateway/tsconfig.json --noEmit
npx tsc -p src/agents/tsconfig.json --noEmit
```

The root `tsconfig.json` enables both `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. When constructing objects with optional fields,
prefer:

```typescript
{ ...(value !== undefined ? { foo: value } : {}) }
```

over `{ foo: value ?? undefined }` — the latter fails the strict check.

### Project rules (learned the hard way)

- **LLM Router never calls DexScreener or GoPlus.** It returns
  `chain: "evm" | "solana"` only — sub-chain resolution belongs to Quote/Safety.
- **Always resolve chains via DexScreener first; never hardcode chain IDs.**
  LLM-provided token names are overridden by on-chain pair data.
- **Amounts are always `{ value, unit }`** — `0.5 ETH` is
  `{ value: 0.5, unit: "NATIVE" }`. `unit` is `"NATIVE" | "USD" | "TOKEN"`.
- **DexScreener search accepts a single word.** Strip extras client-side.
- **MEV protection is always on.** Mainnet EVM swaps route through KeeperHub
  with a 3-failure / 5-minute circuit breaker; Solana uses Jito.
- **Honeypot.is is EVM-only.** Use RugCheck for Solana tokens.
- **Strategy validates chain + liquidity before mode logic.** Rejects
  testnet-vs-mainnet mismatches and liquidity below $500.
- **Monitor emits `EXECUTE_SELL` but never executes.** The Execution agent
  owns every on-chain submission.

---

## On-chain deployments

| Network            | Contract                                     | Chain ID |
| ------------------ | -------------------------------------------- | -------- |
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602    |
| 0G Mainnet         | _Pending mainnet wallet funding_             | 16661    |

Deploy with:

```bash
npx tsx scripts/deploy-registry.ts
```

---

## Status and known limitations

This is a hackathon build. The trading paths that are actively used in demos
(EVM buy → monitor → partial-exit sell on Base/Arbitrum/Ethereum/BSC) work
end-to-end. The rougher edges:

- **Solana execution is stubbed.** The Execution agent currently returns a
  `sol-pending-…` placeholder for Solana swaps; the EVM path is the production
  path.
- **Monitor skips FDV / market-cap exits.** `Position` does not carry
  `totalSupply`, so multiplier and price targets work but FDV/MC targets are
  logged and skipped.
- **Copy-trade WebSocket is global.** All watched wallets share one
  DexScreener subscription and parse every pair update; fine for a small
  watchlist, wasteful at scale.
- **Once 0G falls back, it stays fallen back** for the process lifetime — no
  periodic re-probing.
- **`HawkeyeRegistry.registerAgent`** uses `keccak256(name, block.timestamp)`
  as the agent ID — same name registered twice in the same block would
  collide. Owner-only mitigates the practical risk.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Branch off `feat/<name>-<feature>`,
add or modify code under your agent's `src/agents/<name>/` folder, and open a
PR into `main`. Smoke tests must pass before merge.

`src/shared/types.ts`, `src/gateway/`, and `src/index.ts` are reserved to
avoid merge conflicts during the hackathon push — coordinate before touching
them.

---

## License

ISC
