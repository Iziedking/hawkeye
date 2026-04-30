# HAWKEYE Build Plan

Autonomous crypto trading agent swarm for the OpenAgent Hackathon by ethGlobal.

## Current status (as of 2026-04-30)

All 7 agents merged and wired. CI passes (typecheck + lint + format). 0G contract deployed
to testnet with all agents registered. Audit trail writes every lifecycle step to 0G Storage
and 0G Chain. Gensyn AXL bus transport built. FEEDBACK.md verified against live Uniswap docs.

### What's in this repo

| Module              | Path                                                                 | Status                            |
| ------------------- | -------------------------------------------------------------------- | --------------------------------- |
| Event Bus           | `src/shared/event-bus.ts`                                            | Done                              |
| AXL Bus Transport   | `src/shared/axl-bus.ts`                                              | Done (bridges to Gensyn P2P)      |
| Shared types        | `src/shared/types.ts`                                                | Done                              |
| Constants           | `src/shared/constants.ts`                                            | Done                              |
| Health system       | `src/shared/health.ts`                                               | Done (HTTP + Telegram /status)    |
| Token resolver      | `src/shared/tokens.ts`                                               | Done                              |
| Wallet persistence  | `src/shared/store.ts`                                                | Done                              |
| Swarm tracer        | `src/shared/swarm-tracer.ts`                                         | Done                              |
| EVM chains          | `src/shared/evm-chains.ts`                                           | Done (15 chains, Ankr RPCs)       |
| LLM Router          | `src/gateway/llm-router.ts`                                          | Done                              |
| Telegram Gateway    | `src/gateway/telegram-gateway.ts`                                    | Done (primary, /status command)   |
| OpenClaw Adapter    | `src/gateway/openclaw-adapter.ts`                                    | Done (reference, not active)      |
| Claude LLM fallback | `src/integrations/claude/`                                           | Done (FallbackLlmClient)          |
| Privy wallets       | `src/integrations/privy/`                                            | Done                              |
| 0G Compute          | `src/integrations/0g/compute.ts`                                     | Done                              |
| 0G Storage          | `src/integrations/0g/storage.ts`                                     | Done                              |
| 0G Registry Client  | `src/integrations/0g/registry-client.ts`                             | Done (runtime logTrade)           |
| 0G Audit Trail      | `src/integrations/0g/audit-trail.ts`                                 | Done (6 bus events)               |
| Safety Agent        | `src/agents/safety/`                                                 | Done (Samuel)                     |
| Quote Agent         | `src/agents/quote/`                                                  | Done (Sunday)                     |
| Strategy Agent      | `src/agents/strategy/`                                               | Done                              |
| Execution Agent     | `src/agents/execution/`                                              | Done (Sunday)                     |
| Research Agent      | `src/agents/research/`                                               | Done (Samuel)                     |
| Monitor Agent       | `src/agents/monitor/`                                                | Done (Joshua)                     |
| Copy Trade Agent    | `src/agents/copy-trade/`                                             | Done (Joshua)                     |
| HawkeyeRegistry     | `contracts/HawkeyeRegistry.sol`                                      | Deployed to testnet               |
| Deploy script       | `scripts/deploy-registry.ts`                                         | Done (--testnet flag)             |
| FEEDBACK.md         | `FEEDBACK.md`                                                        | Done (verified against live docs) |
| MCP servers         | openclaw-docs, dexscreener, goplus, gensyn-axl, coingecko, keeperhub | Done                              |
| Main startup        | `src/index.ts`                                                       | Done (all wiring complete)        |

### Architecture

```
User (Telegram)
  |
  v
Telegram Gateway (grammY)
  |
  v
LLM Router (0G Compute primary, Claude fallback, regex last resort)
  |
  +-- DEGEN_SNIPE/TRADE --> TRADE_REQUEST on bus
  |     |-- Safety Agent (GoPlus + Honeypot/RugCheck) --> SAFETY_RESULT
  |     |-- Quote Agent (DexScreener + Uniswap) --> QUOTE_RESULT
  |     |-- Strategy Agent (merges safety + quote) --> STRATEGY_DECISION
  |     |-- Execution Agent (Uniswap Trading API + KeeperHub) --> TRADE_EXECUTED
  |     |-- Monitor Agent (polls prices, trailing stops) --> EXECUTE_SELL
  |     `-- 0G Audit Trail (Storage writes + Chain logTrade at every step)
  |
  +-- RESEARCH_TOKEN --> Research Agent --> RESEARCH_RESULT
  +-- GENERAL_QUERY --> Second LLM call --> intelligent reply
  +-- BRIDGE/PORTFOLIO/COPY_TRADE --> bus event + coming-soon reply
  `-- SETTINGS --> session update

Bus Transport: EventEmitter (local) <--> Gensyn AXL (P2P, when node available)
```

### 0G integration (3 components)

1. **0G Compute** — LLM brain. Classifies every message, powers conversational replies, agent analysis. Verified inference via `processResponse()`.
2. **0G Storage** — Immutable audit trail. Writes at 6 lifecycle points: intent, safety, strategy, execution, research, alpha. Each write returns a rootHash for verification.
3. **0G Chain** — On-chain registry. `HawkeyeRegistry` contract records agent identities and trade execution proofs. `storeIntent()` on every trade, `logTrade()` on every execution.

Narrative: "0G Compute thinks, 0G Storage remembers, 0G Chain proves."

### Gensyn AXL integration

`AxlEventBus<E>` implements the same interface as `EventBus<E>`. On emit, events broadcast to all AXL peers via the local node HTTP API. Polls `/recv` for inbound events. 10 core bus events are bridged bidirectionally. Agents never know which transport is active.

Requires AXL node running (`AXL_API_URL` env var). Falls back to local-only EventEmitter if unreachable.

### On-chain deployments

| Network            | Contract                                     | Chain ID | Explorer                |
| ------------------ | -------------------------------------------- | -------- | ----------------------- |
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602    | chainscan-galileo.0g.ai |
| 0G Mainnet         | Not deployed yet                             | 16661    | chainscan.0g.ai         |

## Remaining work

### Must-have (before May 3 deadline)

- [ ] Deploy 0G mainnet contract (requires funded mainnet wallet)
- [ ] KeeperHub real auth + working demo (currently stub in Execution Agent)
- [ ] Real transaction testing on mainnet (small amounts on Base/Arbitrum)
- [ ] README with architecture diagram
- [ ] Demo video (3 min max)
- [ ] Public X post

### Nice-to-have

- [ ] ENS integration (agent identity resolution, $2,500 prize)
- [ ] KeeperHub builder feedback bounty ($250)
- [ ] Gensyn AXL cross-node demo (two separate AXL nodes communicating)
- [ ] Frontend dashboard (Stephanie)
- [ ] Multi-turn conversation context
- [ ] Encrypted wallet store

## How it all connects

Every user message hits the LLM Router, which classifies it into one of 10 intent categories. The router has a degen shortcut: bare contract addresses (with or without "ape"/"buy") skip the LLM entirely for sub-millisecond speed.

**Degen snipe / Trade flow** (bare CA or explicit trade):

```
0ms    LLM Router -> DEGEN_SNIPE/TRADE -> TRADE_REQUEST emitted
0ms    Safety Agent starts checking the token
0ms    Quote Agent starts fetching prices
0ms    0G Audit Trail writes intent to Storage + Chain
~1.5s  SAFETY_RESULT comes back -> 0G Storage writes safety report
~1s    QUOTE_RESULT comes back
~1.5s  Strategy Agent has both, makes the call -> 0G Storage writes decision
~1.6s  EXECUTE_TRADE emitted
~2.5s  Transaction submitted with MEV protection (KeeperHub)
~5s    Transaction confirmed on chain
~5.1s  TRADE_EXECUTED emitted -> 0G Storage writes proof, 0G Chain logs trade
~5.1s  Monitor starts watching, user gets entry price and tx hash
```

## Env vars

Copy `.env.example` to `.env.local` and fill in:

```
TELEGRAM_BOT_TOKEN=           # Required: Telegram bot via BotFather
HAWKEYE_EVM_PRIVATE_KEY=      # Required: 0G Compute + Storage + Chain
OG_PROVIDER_URL=              # Required: 0G RPC
ANTHROPIC_API_KEY=            # Recommended: Claude fallback LLM
PRIVY_APP_ID=                 # Recommended: agent wallets
PRIVY_APP_SECRET=             # Recommended: agent wallets
HAWKEYE_REGISTRY_ADDRESS=     # Required: deployed HawkeyeRegistry contract
OG_CHAIN_ID=                  # 16661 for mainnet, 16602 for testnet
OG_MAINNET_RPC=               # https://evmrpc.0g.ai or testnet variant
AXL_API_URL=                  # http://127.0.0.1:9002 (when AXL node running)
UNISWAP_API_KEY=              # Optional: Uniswap Trading API
GOPLUS_KEY=                   # Optional: GoPlus MCP
GOPLUS_SECRET=                # Optional: GoPlus MCP
KH_API_KEY=                   # Optional: KeeperHub MCP
```

## Sponsors

| Sponsor    | What we use it for                                   | Integration depth                    |
| ---------- | ---------------------------------------------------- | ------------------------------------ |
| 0G Compute | LLM router + conversational replies + agent analysis | Deep: core brain, every message      |
| 0G Storage | Immutable audit trail at 6 lifecycle points          | Deep: every trade fully logged       |
| 0G Chain   | On-chain agent registry + trade execution proofs     | Deep: runtime logTrade calls         |
| Gensyn AXL | P2P bus transport between agent nodes                | Medium: built, needs cross-node demo |
| KeeperHub  | EVM tx execution and gas management                  | Shallow: MCP wired, stub in agent    |
| Uniswap    | DEX integration for EVM swaps (Trading API)          | Deep: 3-step flow in Execution Agent |
| Privy      | Per-user agent wallets, signing                      | Deep: live in Telegram gateway       |

## Deadline

2026-05-03 23:59 UTC+8

Submission requires: public GitHub repo, 0G mainnet contract address, demo video (3 min max), README with architecture diagram, and a public X post.
