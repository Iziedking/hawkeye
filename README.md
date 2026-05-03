# HAWKEYE

HAWKEYE is an autonomous on-chain trading agent that lives in your Telegram chat.

> **Scope today: EVM only.** Trade execution ships on Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, and Sepolia testnet. Solana trade execution is **coming soon** — the agents and Jupiter quote path are scaffolded but not live. Solana token research (RugCheck, GoPlus Solana, Birdeye) is already wired into the Research and Safety agents.

Behind the bot is a swarm of seven specialised agents that talk to each other over a typed event bus. They split the work the way a real trading desk would: one watches for risk, one prices the trade, one decides whether to pull the trigger, one places the swap, one watches the position after entry, one researches new tokens, and one mirrors interesting wallets.

The agents run on **0G Compute** (verifiable LLM inference), persist memory to **0G Storage**, and register their identities and trade decisions on **0G Chain**. Trades route through **Uniswap**, mainnet swaps are MEV-protected by **KeeperHub**, wallets are provisioned per user by **Privy**, and the swarm can be bridged across nodes via **Gensyn AXL**.

> **0G Mainnet contract:** [`0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F`](https://chainscan.0g.ai/address/0x3beAE6d896Fe7B9d0694fcce2A482Bf8e9E50F2F) on chain `16661`. All seven agents are registered on-chain.

---

## Table of contents

- [Architecture](#architecture)
- [How a trade flows](#how-a-trade-flows)
- [The seven agents](#the-seven-agents)
- [Skill system](#skill-system)
- [Event bus contract](#event-bus-contract)
- [LLM fallback chain](#llm-fallback-chain)
- [0G integration](#0g-integration)
- [Sponsor integrations](#sponsor-integrations)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Commands](#commands)
- [Telegram commands](#telegram-commands)
- [Development workflow](#development-workflow)
- [On-chain deployments](#on-chain-deployments)
- [Partner integrations](#partner-integrations)
- [Web API](#web-api)
- [Status and roadmap](#status-and-roadmap)
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

A bare contract address pasted into Telegram skips the LLM entirely and hits the bus in under a millisecond. We call it the degen shortcut, because that is what it is for.

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

All agents talk to each other only through the bus. No agent imports another directly. By default the bus is a local `EventEmitter`. When `AXL_API_URL` is set, the same events are bridged peer-to-peer through Gensyn AXL, which is how cross-node swarms work.

---

## Skill system

Every agent that talks to an LLM composes its system prompt from a stack of skills written in plain markdown.

Each skill lives under `src/skills/available/` as a single `.md` file. The frontmatter declares the skill's name, a short description, whether it is enabled by default, a priority (higher priority overrides lower when guidance conflicts), and a list of tags. The body is just the rules in plain English.

The loader at `src/shared/skills.ts` reads the directory at boot, parses the frontmatter, sorts skills by priority, and injects the relevant ones into each agent's prompt. The selection is filtered by tag, so the Strategy agent sees the safety, risk-management and MEV skills, the Research agent sees the analysis, whale and narratives skills, and so on. Nothing is hardcoded; drop a new file in the directory and the agents pick it up next boot.

| Skill                 | Priority | Default | Purpose                                                            |
| --------------------- | -------- | ------- | ------------------------------------------------------------------ |
| Rug Detector          | 100      | off     | Always-on safety override when triggered; specific scam patterns   |
| Safety First          | 95       | on      | Conservative trading mode with hard refusal on red flags           |
| MEV Shield            | 92       | on      | Per-chain MEV protection guidance + slippage tables                |
| Degen Trader          | 90       | on      | Aggressive memecoin personality; balances against safety priors    |
| Smart Contract Reader | 88       | on      | Contract code interpretation; surface tax / mint / blacklist hooks |
| Token Analyst         | 85       | on      | Structured tokenomics + market positioning breakdown               |
| Onchain Forensics     | 84       | on      | Wallet tracing; identify suspicious onchain patterns               |
| DeFi Strategist       | 82       | on      | Yield, lending, liquidity strategy guidance                        |
| Chain Expert          | 80       | on      | Multi-chain gas optimization and bridge recommendations            |
| Whale Watcher         | 77       | on      | Smart-money flow analysis from Arkham / Nansen / Dune              |
| Sniper Entry          | 75       | on      | Entry tactics for new launches and low-cap plays                   |
| Memecoin Oracle       | 73       | off     | Memecoin lifecycle and narrative timing                            |
| Gas Optimizer         | 72       | on      | Gas estimation and timing across chains                            |
| Alpha Hunter          | 70       | on      | Trend / sector identification                                      |
| Bridge Navigator      | 68       | on      | Cross-chain routing comparison                                     |
| Portfolio Coach       | 65       | on      | Position sizing and diversification advice                         |

Skills are togglable per user. `/skills` in Telegram lists every skill with its current state, `/skills on rug-detector` flips one on, `/skills off degen-trader` flips one off. Overrides persist to `data/skill-overrides.json` so a user's choices survive restarts. The skill stack is currently wired into the gateway's conversational replies, the Strategy agent's reasoning, and the Research agent's summaries.

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

The LLM Router and several agents share a single `FallbackLlmClient` defined in `src/integrations/claude/index.ts`. It wraps four tiers and routes every inference request through them in order.

The first tier is **0G Compute**, our primary path. Inference happens through the 0G Serving Broker, and where TEE attestations are returned we verify them with `processResponse()`.

The second tier is **OpenRouter**, configurable through `OPENROUTER_MODEL` (default `google/gemini-2.5-flash-lite`). It only sees traffic when 0G Compute is unhealthy.

The third tier is **Claude**, gated on `ANTHROPIC_API_KEY`, which only sees traffic when both 0G Compute and OpenRouter are unavailable.

The fourth tier is the **regex-only fallback**. If every LLM is gone, bare-address degen snipes still work and intent classification degrades to keyword heuristics. The bot never goes fully dark.

### Self-healing routing

Failures are tracked per call. When 0G Compute throws, the client marks the primary tier unhealthy and suppresses it for five minutes. Every request inside that window goes straight to the fallback. After the window, the next request gets one re-probe of 0G. If the re-probe succeeds, the primary path is restored automatically and the log shows `0G Compute recovered`. A single outage now costs one extra timeout, not one per inference call, and a recovered 0G picks up traffic again without an operator restart.

The `/llm` Telegram command shows the live routing state, including which tier is active, what is configured, and how much suppression time is left. `/llm reset` forces an immediate re-probe, which is handy if you have just funded the 0G ledger and don't want to wait out the window.

---

## 0G integration

HAWKEYE uses three 0G components. All three are funded from the same `HAWKEYE_EVM_PRIVATE_KEY`.

### 0G Compute (`src/integrations/0g/compute.ts`)

This is the LLM brain. It classifies every user message into an intent category, powers our conversational replies, and drives the Strategy and Research agents. Inference is verified through `processResponse()`. The client preflights the ledger balance before each call and serializes broker calls by nonce.

### 0G Storage (`src/integrations/0g/storage.ts`, `audit-trail.ts`)

This is the immutable audit trail. We write at six points in the trade lifecycle, and each write returns a verifiable `rootHash`:

1. `TRADE_REQUEST` for the intent payload.
2. `SAFETY_RESULT` for the safety report (cached locally so it can be matched to the eventual `TRADE_EXECUTED` log).
3. `STRATEGY_DECISION` for the execute, reject, or await-confirm reason.
4. `TRADE_EXECUTED` for the receipt with the tx hash.
5. `RESEARCH_RESULT` for the synthesis.
6. `ALPHA_FOUND` for the background-discovery loop.

Writes go through a sequential queue with a circuit breaker. After three failures the breaker opens for five minutes, so a slow indexer can never block the trade path.

### 0G Chain (`src/integrations/0g/registry-client.ts`, `contracts/HawkeyeRegistry.sol`)

`HawkeyeRegistry` is the on-chain receipt for the swarm. It records agent identities and the proofs of every trade decision.

The contract exposes a small surface. `registerAgent(name, role)` is owner-only and stores agent metadata. `storeIntent(intentId, data)` is called on every `TRADE_REQUEST` and emits the intent on chain. `logTrade(intentId, token, chain, safetyScore, decision)` is appended on every `TRADE_EXECUTED`. Reads come from `getAgentCount()`, `getTradeCount()`, and `getActiveAgents()`.

Chain writes have their own sequential queue, separate from Storage, so neither blocks the other.

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

Anthropic Claude and OpenRouter are not sponsors. They sit in the fallback chain for the moments when 0G Compute is unavailable.

---

## Setup

```bash
git clone <repo-url> && cd hawkeye
npm install
cp .env.example .env.local       # fill in required vars (see below)
npm start                         # launches Telegram bot
```

Node 22 or newer is recommended. The OpenClaw adapter uses the global `WebSocket` implementation that shipped with Node 22.

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

| Command      | What it does                                                   |
| ------------ | -------------------------------------------------------------- |
| `/start`     | Welcome message and setup                                      |
| `/wallet`    | Create or view agent wallet                                    |
| `/balance`   | Native balances across configured chains                       |
| `/positions` | Open trades and live PnL                                       |
| `/history`   | Recent trade history                                           |
| `/send`      | Transfer native tokens to another wallet                       |
| `/mode`      | Trading mode (`degen`, `normal`, `safe`) and default amount    |
| `/skills`    | List behavior skills, `/skills on \|off <id>` toggles per-user |
| `/llm`       | Show LLM routing state; `/llm reset` forces a 0G re-probe      |
| `/watch`     | Mirror a wallet's buys via copy-trade                          |
| `/unwatch`   | Stop copying a wallet                                          |
| `/watchlist` | Show currently watched wallets                                 |
| `/link`      | Add email recovery to wallet                                   |
| `/status`    | System health and agent status                                 |
| `/help`      | Full command guide                                             |

You don't have to use commands. Paste any contract address and the trade flow starts immediately. Natural-language messages such as _"what's trending on Ethereum?"_ get routed through the LLM to the right agent.

### Sell-amount syntax (natural language)

When you sell, the Execution agent reads your live on-chain balance and uses that as the source of truth. It converts whatever you said into an exact token amount in the token's own decimals and sends an `EXACT_INPUT` swap to Uniswap. We never use `EXACT_OUTPUT` for sells.

Any of these phrasings work:

| You say            | What happens                                               |
| ------------------ | ---------------------------------------------------------- |
| `sell 50% of PEPE` | Reads your on-chain balance and sells half of it.          |
| `sell all my LINK` | Sells your entire on-chain balance.                        |
| `dump everything`  | Same idea, applied to the position you are looking at.     |
| `sell $25 of UNI`  | Computes tokens at live price, capped at on-chain balance. |
| `sell 100 PEPE`    | Sells exactly 100 tokens, capped at on-chain balance.      |
| `exit half my bag` | Treated as 50%.                                            |

Internally the `AmountUnit` type carries `"NATIVE"`, `"USD"`, `"TOKEN"`, or `"PERCENT"`. The LLM Router also has a regex backstop on the raw text, so phrases like `"50%"` or `"all"` still resolve to the right unit even if the LLM forgets to set it.

---

## Development workflow

Each subtree of the repo has its own `tsconfig.json`. The gateway, the agents folder, and each integration set their own TypeScript options (for example, `verbatimModuleSyntax` is relaxed for agents). The root `tsc` is not expected to pass on its own. Always typecheck through the scoped configs:

```bash
npx tsc -p src/shared/tsconfig.json --noEmit
npx tsc -p src/gateway/tsconfig.json --noEmit
npx tsc -p src/agents/tsconfig.json --noEmit
```

The root `tsconfig.json` turns on both `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. When you construct an object that may include an optional field, the strict-checked pattern is:

```typescript
{ ...(value !== undefined ? { foo: value } : {}) }
```

The shorter `{ foo: value ?? undefined }` looks the same but fails the strict check.

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

The same `HAWKEYE_EVM_PRIVATE_KEY` funds Compute, Storage, and Chain. The boot script prints a balance warning if it is low. The boot banner shows the live status of each 0G primitive: `0G Compute [ON/OFF]`, `0G Storage [ON]`, `0G Chain [ON]`.

### Uniswap, the execution layer

The Execution agent is built directly on the Uniswap Trading API.

Every swap is a three-step flow: `POST /check_approval`, then `POST /quote`, then `POST /swap`. The flow is Permit2-aware. Classic routes use the on-chain ERC20 approval path. UniswapX routes (`DUTCH_V2`, `DUTCH_V3`, `PRIORITY`) attach the Permit2 signature instead.

When Uniswap returns an error, our `humanizeQuoteError` helper translates the 4xx/5xx body into something the user can act on. Instead of `INSUFFICIENT_LIQUIDITY` they see "this token might not be tradeable on this chain", and instead of `Execution reverted` on a sell they see "your wallet doesn't hold this token, or doesn't have gas".

Before we even quote, the agent calls `fetchTokenBalance` and refuses to sell tokens you don't hold. That alone removes the most common revert class. The integration is wired across more than 17 EVM chains, and chain selection always goes through DexScreener so we never trust a chain hint from the LLM.

See [`FEEDBACK.md`](./FEEDBACK.md) for the full builder-experience write-up required by the Uniswap track. The code lives in `src/agents/execution/index.ts`, with prompt-engineering hints under `.agents/skills/swap-integration/` and `.agents/skills/swap-planner/`.

### KeeperHub, MEV protection and reliability

Every mainnet swap on EVM (Ethereum, Base, Arbitrum, Optimism, BSC, Polygon) routes through KeeperHub. Solana trade execution (with Jito for MEV) is on the roadmap; the EVM path is what ships today.

KeeperHub failures don't break the user's trade. `KeeperHubClient.circuitOpen` flips on transient errors and the trade falls through to the wallet manager without aborting. At boot, a reachability probe writes `[execution] KeeperHub reachable, all mainnet swaps will be MEV-protected` so an operator can tell whether protection is live without checking logs after the fact.

The KeeperHub MCP server is also pre-wired into `.mcp.json` so agent skills can call it directly. Paths: `src/integrations/keeperhub/` and `src/integrations/keeperhub/dual-wallet.ts`. The builder-feedback bounty write-up lives in [`KEEPERHUB-FEEDBACK.md`](./KEEPERHUB-FEEDBACK.md).

### Gensyn AXL, P2P swarm transport

The local `EventBus` and the `AxlEventBus` implement the same interface, so the agents never know which one is active. When `AXL_API_URL` is set, the bridge in `initAxlBus()` mirrors a configured set of bus events over Gensyn AXL P2P transport. A `forwarding` flag breaks the obvious re-emit loops between local and remote.

Paths: `src/shared/axl-bus.ts`, plus the local MCP server at `src/tools/gensyn-axl-mcp/` that wraps AXL topology and messaging.

### Privy, per-user agent wallets

Logging in with an email provisions a managed EVM agent wallet for that user. The wallet is server-custodied: HAWKEYE signs and submits every trade, swap, and `/send` on the user's behalf using a Privy server-side **authorization key** (`PRIVY_AUTHORIZATION_PRIVATE_KEY`), and ownership is bound to that key via `owner: { public_key }` at wallet creation. The user authenticates by signing back in with the same email — the wallet stays bound to their account across sessions and platforms.

This is intentionally not a self-custody wallet. The private key is **not** exportable through the Privy UI; that is the trade-off for one-tap trading and the security model HAWKEYE is built around. Sending native tokens out of the agent wallet (`/send`) is fully supported, so funds are never trapped — users decide what flows in and what flows out, the bot just handles the on-chain mechanics.

Users can also link an **external wallet** via RainbowKit and a SIWE-style signed nonce, which attaches the wallet to the same email-rooted profile. After linking, the user can flip between agent and external as the active wallet. Trades from the agent wallet stay one-tap; trades from an external wallet require an explicit signature on each one. See `src/integrations/privy/index.ts`.

---

## Web API

Telegram is the primary surface, but the bot also serves a small read/write HTTP API on the same port as `/health` (default `:8080`, configurable via `HEALTH_PORT`). CORS is open so a Next.js dashboard can call it directly.

| Endpoint                         | Method | Purpose                                                              |
| -------------------------------- | ------ | -------------------------------------------------------------------- |
| `/health`                        | GET    | Aggregate health, agent and subsystem report.                        |
| `/api/agents/health`             | GET    | Same payload, namespaced under `/api/`.                              |
| `/api/profile?email=…`           | GET    | Privy agent wallet, linked external wallets, and active wallet ref.  |
| `/api/positions?email=…`         | GET    | Open positions and last 20 trades for the user.                      |
| `/api/link-wallet/nonce?email=…` | GET    | Mint a single-use nonce and the message to sign.                     |
| `/api/link-wallet`               | POST   | `{ email, address, signature }`; verifies the signature and binds.   |
| `/api/active-wallet`             | POST   | `{ email, kind: "agent" \| "external", address? }`; switches active. |

The link-wallet flow is SIWE-style. The server mints a nonce with a 5-minute TTL. The message you sign includes your email and the nonce. The server verifies the signature with `ethers.verifyMessage` and binds the wallet through `connectExternalWallet` in `src/integrations/privy/index.ts`.

From the dashboard:

1. `GET /api/link-wallet/nonce?email=…` returns `{ nonce, message }`.
2. Wagmi or RainbowKit signs the message with the connected external wallet.
3. `POST /api/link-wallet` with `{ email, address, signature }`.
4. The server returns the updated profile, and the UI re-renders the wallet list and the active-wallet switcher.

Trades from the agent wallet stay one-tap. Trades from an external wallet require a signature each time. The `activeWallet` field on `StoredUser` (in `src/shared/store.ts`) is a discriminated union of `{ kind: "agent" }` and `{ kind: "external", address }`, which lets a single user flip between the two without losing either.

---

## Status and roadmap

The EVM trade lifecycle is production-quality end to end on the chains we demo with: Ethereum, Base, Arbitrum, Optimism, BSC, and Polygon. A natural-language intent flows through safety, quoting, strategy, MEV-protected execution, and a live monitor that fires TP/SL exits. That includes FDV and market-cap exit targets, evaluated against `priceNow × totalSupply` which we derive from DexScreener at quote time.

### Resilience we built during this hackathon

The LLM routing is self-healing. When 0G Compute fails, the primary tier is suppressed for five minutes and every request goes straight to the fallback. After that window the next request re-probes 0G, and if it works the primary path is restored automatically. A single outage now costs one timeout, not one per request. The state is visible via `/llm` and can be reset by hand with `/llm reset`.

The 0G Storage layer has its own circuit breaker. Three consecutive write failures opens it for five minutes. Audit-trail problems never block the trade path, reads stay available, and writes resume on their own once the indexer recovers.

KeeperHub uses the same pattern. When it is unreachable, we fall through to the wallet manager so the user never sees a hard failure on a swap.

Sells size off your live on-chain balance, in token decimals, capped at what you actually hold. That makes a position always exit-able even when price drift or balance changes since the buy would otherwise produce a bad amount.

### On the roadmap

Solana trade execution is **coming soon** — the focus today is EVM. The agents are already wired, the Jupiter quote path is stubbed in, and on-chain submission via Privy Solana wallets is in flight. Until that lands, anything Solana-related in the trade path returns a clear "coming soon" message; the Research and Safety agents already cover Solana tokens via RugCheck, GoPlus Solana, Jupiter strict list, and Birdeye.

Copy-trade currently uses a single shared DexScreener WebSocket. That is efficient for the small watchlists every demo user has, but per-wallet subscriptions are the right design once we are scaling to thousands of watchers.

0G Compute and 0G Storage run on Galileo testnet for now. That follows 0G's own deployment guidance: free public Compute providers and Storage indexers currently live on testnet, while the Chain registry is full mainnet. We will migrate Compute and Storage as soon as the mainnet endpoints open up.

---

## Contributing

The full guide is in [CONTRIBUTING.md](CONTRIBUTING.md).

Short version: branch off `feat/<name>-<feature>`, modify code only under your agent's `src/agents/<name>/` folder, and open a PR into `main`. Smoke tests must pass before merge.

`src/shared/types.ts`, `src/gateway/`, and `src/index.ts` are reserved during the hackathon push to avoid merge conflicts. Coordinate before touching them.

---

## License

ISC
