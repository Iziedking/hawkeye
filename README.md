# HAWKEYE

Autonomous crypto trading agent swarm on Telegram. Seven specialized agents
coordinate through a typed event bus to handle the full trade lifecycle: safety
checks, quoting, strategy, execution, monitoring, research, and copy trading.

Built for the **Open Agent Hackathon**. Powered by **0G Compute** (LLM),
**0G Storage** (audit trail), and **0G Chain** (on-chain registry), with
**Gensyn AXL** for P2P swarm transport, **KeeperHub** for MEV protection,
**Uniswap** for routing, and **Privy** for per-user wallets.

> **0G Mainnet contract**: [`0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F`](https://chainscan.0g.ai/address/0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F) — chain `16661`. All seven agents registered on-chain.

---

## Submission — partner prize eligibility

HAWKEYE applies partner technologies as load-bearing infrastructure rather than
checkbox integrations. Quick map for judges:

| Partner / track                                  | Where it lives in HAWKEYE                                                                                                                                                                                                | Required deliverable                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **0G — Track A: Framework / Tooling**            | Reusable agent-swarm framework: typed event bus, skill system (`src/skills/`), 0G Storage audit pattern (6 lifecycle write-points), `HawkeyeRegistry` contract on 0G Mainnet. Other builders can reuse the bus + skills. | Mainnet contract ✅, repo ✅, demo video ✅                            |
| **0G — Track B: Autonomous Agents / Swarms**     | 7-agent swarm with bus-based coordination (`src/agents/`), persistent memory in 0G Storage, sealed inference via 0G Compute, on-chain provenance via `HawkeyeRegistry`. AXL-bridge ready for cross-node swarms.          | Architecture diagram ✅, working examples ✅                           |
| **Uniswap Foundation — Trading API integration** | Execution agent built on Uniswap Trading API (`src/agents/execution/index.ts`). 3-step flow (`/check_approval` → `/quote` → `/swap`) across 17+ EVM chains; Permit2-aware; routing-aware error humanization.             | [`FEEDBACK.md`](./FEEDBACK.md) ✅ (required)                           |
| **KeeperHub — MEV-protected execution**          | Every mainnet swap routes through KeeperHub with circuit-breaker fall-through (`src/integrations/keeperhub/`). MCP server pre-wired in `.mcp.json`. Boot-time reachability probe.                                        | [`KEEPERHUB-FEEDBACK.md`](./KEEPERHUB-FEEDBACK.md) ✅ (builder bounty) |
| **Gensyn — AXL transport**                       | Same `EventBus` interface, swappable backend: `LocalEventBus` or `AxlEventBus` for cross-node P2P coordination. Bridge in `initAxlBus()` with re-emit-loop guard.                                                        | Cross-node demo (run multiple nodes for full credit)                   |

We're applying for **0G** (both tracks count as one partner prize per ETHGlobal
rules), **Uniswap**, and **KeeperHub** — three partners, the maximum per the
submission form. KeeperHub's Builder Feedback Bounty is independent and we're
also submitting that.

See [`FEEDBACK.md`](./FEEDBACK.md) and [`KEEPERHUB-FEEDBACK.md`](./KEEPERHUB-FEEDBACK.md)
for the candid builder-experience write-ups, and the
[Partner integrations section](#partner-integrations) below for the full
file-level mapping.

### Anti-hallucination (judging criterion: practicality)

The LLM never invents data that hits execution. Hard guards:

- **Addresses must be in the user's message verbatim**. `validateTradeData`
  (`src/gateway/llm-router.ts`) rejects any LLM-returned token address that
  isn't found in the original user text. Same guard for SEND_TOKEN recipients.
- **Side is preserved end-to-end.** A previous bug where the validator
  hardcoded `side: "buy"` is now fixed; sells flow through correctly.
- **Chains resolve via DexScreener, never LLM hints.** The Quote agent
  populates `tokenName`/`tokenSymbol` from `pair.baseToken` so on-chain
  truth overrides anything the LLM said.
- **Sells short-circuit Strategy gates.** Users can always attempt to exit a
  position they hold; chain-mismatch / liquidity-floor rejects only apply to
  buys.

---

## Table of contents

- [Submission — partner prize eligibility](#submission--partner-prize-eligibility)
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
- [Partner integrations](#partner-integrations)
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

### 0G Mainnet (production)

| Field         | Value                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contract**  | [`0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F`](https://chainscan.0g.ai/address/0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F)                                            |
| **Chain ID**  | `16661`                                                                                                                                                               |
| **Network**   | 0G Mainnet (`https://evmrpc.0g.ai`)                                                                                                                                   |
| **Deploy tx** | [`0xc85dbc81bd9f9c0ae0642829aca0fe0984591832a1a611298f56605c9fd1851d`](https://chainscan.0g.ai/tx/0xc85dbc81bd9f9c0ae0642829aca0fe0984591832a1a611298f56605c9fd1851d) |
| **Explorer**  | https://chainscan.0g.ai                                                                                                                                               |

All seven agents are registered on-chain in a single deploy: Safety, Quote,
Strategy, Execution, Research, Monitor, Copy Trade. Every trade intent and
execution decision is logged to this contract via `storeIntent()` and
`logTrade()`, and every payload is also pinned to 0G Storage for the audit
trail.

### Other networks

| Network            | Contract                                     | Chain ID |
| ------------------ | -------------------------------------------- | -------- |
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602    |

Deploy:

```bash
npx tsx scripts/deploy-registry.ts            # mainnet (default)
npx tsx scripts/deploy-registry.ts --testnet  # Galileo testnet
```

---

## Partner integrations

HAWKEYE applies partner technologies as load-bearing infrastructure, not
checkbox items. This section maps each partner's tools to where they show up
in the codebase and what they actually do for the swarm.

### 0G — sealed inference, persistent memory, on-chain registry

| 0G primitive   | What HAWKEYE does with it                                                                                                                                                                                                                     | Path                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **0G Compute** | Primary LLM brain for the router, strategy, and research agents. Sealed inference via `OgComputeClient`; falls back to OpenRouter / Claude only when 0G is unreachable.                                                                       | `src/integrations/0g/compute.ts`, `src/integrations/claude/index.ts`                                    |
| **0G Storage** | Persistent audit trail. Six lifecycle write points: intent, safety report, strategy decision, execution receipt, research result, alpha discovery — each returns a verifiable rootHash that's pinned in Telegram replies and on the contract. | `src/integrations/0g/storage.ts`, `src/integrations/0g/audit-trail.ts`                                  |
| **0G Chain**   | `HawkeyeRegistry` Solidity contract on 0G mainnet (above). 7 agents registered on-chain at deploy; every trade fires `storeIntent()` and `logTrade()` for verifiable swarm provenance.                                                        | `contracts/HawkeyeRegistry.sol`, `src/integrations/0g/registry-client.ts`, `scripts/deploy-registry.ts` |

The same `HAWKEYE_EVM_PRIVATE_KEY` funds Compute, Storage, and Chain — boot
prints a balance warning if it's low. The boot banner shows live status of
each 0G primitive (`0G Compute [ON/OFF]`, `0G Storage [ON]`, `0G Chain [ON]`).

### Uniswap — agent execution layer

The Execution agent is built directly on the **Uniswap Trading API**:

- 3-step flow per swap: `POST /check_approval` → `POST /quote` → `POST /swap`
- Permit2-aware: classic CLASSIC routes use the on-chain ERC20 approve path;
  UniswapX (DUTCH_V2 / DUTCH_V3 / PRIORITY) routes attach the Permit2 signature.
- Routing-aware error humanization (`humanizeQuoteError`) translates 4xx/5xx
  into user-facing messages like "Token may not be tradeable on this chain"
  vs "Wallet doesn't hold this token to sell".
- Pre-flight on-chain balance check via `fetchTokenBalance` blocks an obvious
  class of revert (selling tokens you don't hold).
- 17+ EVM chains, chain ID resolution via DexScreener (no hardcoded chain hints
  trusted from the LLM — see Anti-hallucination below).

See `FEEDBACK.md` for the full builder-experience write-up required by the
Uniswap track.

Path: `src/agents/execution/index.ts`, `.agents/skills/swap-integration/`,
`.agents/skills/swap-planner/`.

### KeeperHub — MEV-protected execution + reliability

| Feature                        | How HAWKEYE uses it                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **MEV-protected swap submit**  | Every mainnet trade is routed through KeeperHub. Solana uses Jito; EVM mainnet (Ethereum, Base, Arbitrum, BSC, Polygon) uses KeeperHub keepers. |
| **Circuit breaker**            | `KeeperHubClient.circuitOpen` flag flips on transient failures, allowing fall-through to the wallet manager without aborting the user trade.    |
| **Connectivity probe at boot** | Boot prints `[execution] KeeperHub reachable — all mainnet swaps will be MEV-protected` so the operator knows MEV protection is live.           |
| **MCP server**                 | Wired into `.mcp.json` for use by agent skills.                                                                                                 |

See `KEEPERHUB-FEEDBACK.md` for the builder-feedback bounty submission.

Paths: `src/integrations/keeperhub/`, `src/integrations/keeperhub/dual-wallet.ts`.

### Gensyn AXL — P2P swarm transport

The local `EventBus` and `AxlEventBus` implement the same interface; agents
never know which is active. When `AXL_API_URL` is set, the bus bridge in
`initAxlBus()` mirrors a configured set of `BusEvents` over Gensyn AXL P2P
transport with a `forwarding` flag to break re-emit loops between local and P2P.

Paths: `src/shared/axl-bus.ts`, `src/tools/gensyn-axl-mcp/` (local MCP server
wrapping AXL topology + messaging).

### Privy — per-user agent wallets

Email-only login provisions an EVM agent wallet per user. External-wallet
linking (RainbowKit + SIWE-style nonce) attaches user-controlled wallets to the
same email-rooted profile so external-wallet trades require explicit signing
while agent-wallet trades stay one-tap. See `src/integrations/privy/index.ts`.

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
