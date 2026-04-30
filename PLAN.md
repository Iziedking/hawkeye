# HAWKEYE Build Plan

Autonomous crypto trading agent swarm for the 0G APAC Hackathon on HackQuest.

## Current status (2026-04-30)

All 7 agents built and wired. Telegram gateway live with wallet provisioning, LLM-first
routing, research delivery, and multi-chain balance checking. OpenRouter added as configurable
LLM fallback (any model). RPC provider swapped from Ankr (now requires auth) to Publicnode
(free, no key). DeFiLlama and Dune Analytics wired into research agent for TVL and smart
money data alongside DexScreener.

### Module status

| Module | Path | Status |
|---|---|---|
| Event Bus | `src/shared/event-bus.ts` | Done |
| AXL Bus Transport | `src/shared/axl-bus.ts` | Done (bridges to Gensyn P2P) |
| Shared types | `src/shared/types.ts` | Done |
| Constants | `src/shared/constants.ts` | Done |
| Health system | `src/shared/health.ts` | Done (HTTP + Telegram /status) |
| Token resolver | `src/shared/tokens.ts` | Done |
| Wallet persistence | `src/shared/store.ts` | Done (V2 schema, multi-wallet) |
| Swarm tracer | `src/shared/swarm-tracer.ts` | Done |
| EVM chains | `src/shared/evm-chains.ts` | Done (16 chains, Publicnode RPCs) |
| LLM Router | `src/gateway/llm-router.ts` | Done (trending routing added) |
| Telegram Gateway | `src/gateway/telegram-gateway.ts` | Done (primary gateway) |
| OpenClaw Adapter | `src/gateway/openclaw-adapter.ts` | Reference only |
| OpenRouter LLM | `src/integrations/openrouter/` | Done (configurable model) |
| Claude LLM | `src/integrations/claude/` | Done (secondary fallback) |
| Privy wallets | `src/integrations/privy/` | Done (multi-wallet, email sign-in) |
| 0G Compute | `src/integrations/0g/compute.ts` | Done (nonce serialization) |
| 0G Storage | `src/integrations/0g/storage.ts` | Done |
| 0G Registry | `src/integrations/0g/registry-client.ts` | Done (runtime logTrade) |
| 0G Audit Trail | `src/integrations/0g/audit-trail.ts` | Done (6 bus events) |
| 0G Balance Check | `src/integrations/0g/shared-signer.ts` | Done (boot warning) |
| KeeperHub | `src/integrations/keeperhub/` | Done (circuit breaker) |
| Safety Agent | `src/agents/safety/` | Done |
| Quote Agent | `src/agents/quote/` | Done |
| Strategy Agent | `src/agents/strategy/` | Done |
| Execution Agent | `src/agents/execution/` | Done (Uniswap 3-step + KeeperHub) |
| Research Agent | `src/agents/research/` | Done (DexScreener + DeFiLlama + Dune) |
| Monitor Agent | `src/agents/monitor/` | Done |
| Copy Trade Agent | `src/agents/copy-trade/` | Done |
| HawkeyeRegistry | `contracts/HawkeyeRegistry.sol` | Deployed to testnet |
| Deploy script | `scripts/deploy-registry.ts` | Done |
| MCP servers | openclaw-docs, dexscreener, goplus, gensyn-axl, coingecko, keeperhub | Done |
| Main startup | `src/index.ts` | Done |

### Architecture

```
User (Telegram)
  |
  v
Telegram Gateway (grammy)
  |
  v
LLM Router (0G Compute -> OpenRouter -> Claude -> regex)
  |
  +-- DEGEN_SNIPE/TRADE --> TRADE_REQUEST on bus
  |     |-- Safety Agent (GoPlus + Honeypot/RugCheck) --> SAFETY_RESULT
  |     |-- Quote Agent (DexScreener + Uniswap) --> QUOTE_RESULT
  |     |-- Strategy Agent (merges safety + quote) --> STRATEGY_DECISION
  |     |-- Execution Agent (Uniswap Trading API + KeeperHub) --> TRADE_EXECUTED
  |     |-- Monitor Agent (polls prices, trailing stops) --> EXECUTE_SELL
  |     `-- 0G Audit Trail (Storage writes + Chain logTrade at every step)
  |
  +-- RESEARCH_TOKEN --> Research Agent (DexScreener + DeFiLlama + Dune) --> RESEARCH_RESULT
  +-- GENERAL_QUERY --> LLM conversational reply
  +-- COPY_TRADE --> Copy Trade Agent (wallet watching)
  +-- PORTFOLIO --> balance check + open positions
  +-- SETTINGS --> session/mode update
  `-- BRIDGE --> bus event + status reply

Bus Transport: EventEmitter (local) <--> Gensyn AXL (P2P, when node available)
```

### 0G integration (3 components)

1. **0G Compute** -- LLM brain. Classifies every message, powers conversational replies and agent analysis. Verified inference via `processResponse()`.
2. **0G Storage** -- Immutable audit trail. Writes at 6 lifecycle points: intent, safety, strategy, execution, research, alpha. Each write returns a rootHash for verification.
3. **0G Chain** -- On-chain registry. `HawkeyeRegistry` contract records agent identities and trade execution proofs. `storeIntent()` on every trade, `logTrade()` on every execution.

### LLM fallback chain

1. 0G Compute (primary, on-chain verifiable)
2. OpenRouter (configurable model via `OPENROUTER_MODEL` env var)
3. Claude (secondary fallback via `ANTHROPIC_API_KEY`)
4. Regex-only (last resort, degen snipes still work)

### On-chain deployments

| Network | Contract | Chain ID |
|---|---|---|
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602 |
| 0G Mainnet | Not deployed yet | 16661 |

## Remaining work

### Must-have (before May 16 deadline)

- [ ] Deploy 0G mainnet contract (requires funded mainnet wallet)
- [ ] Real transaction testing on mainnet (small amounts on Base/Arbitrum)
- [ ] Demo video (3 min max)
- [ ] Public X post
- [ ] Fund 0G testnet wallet with 3+ A0GI for Compute ledger deposit

### Nice-to-have

- [ ] Trade confirmation UX (inline keyboards for confirm/reject)
- [ ] Copy trade user commands (/watch, /unwatch, /watchlist)
- [ ] Trading mode commands (/mode degen, /mode normal, /mode safe)
- [ ] Portfolio with open positions and PnL display
- [ ] Gensyn AXL cross-node demo (two separate AXL nodes communicating)
- [ ] Frontend dashboard
- [ ] Multi-turn conversation context
- [ ] Encrypted wallet store (AES-256-GCM via HAWKEYE_MASTER_KEY)

## Env vars

Copy `.env.example` to `.env.local` and fill in. See `.env.example` for the full list with
descriptions.

## Sponsors

| Sponsor | What we use it for | Integration depth |
|---|---|---|
| 0G Compute | LLM router + conversational replies + agent analysis | Deep: core brain, every message |
| 0G Storage | Immutable audit trail at 6 lifecycle points | Deep: every trade fully logged |
| 0G Chain | On-chain agent registry + trade execution proofs | Deep: runtime logTrade calls |
| Gensyn AXL | P2P bus transport between agent nodes | Medium: built, needs cross-node demo |
| KeeperHub | MEV-protected EVM tx submission with circuit breaker | Medium: wired in execution pipeline |
| Uniswap | DEX swaps via Trading API (3-step flow) | Deep: check_approval + quote + swap |
| Privy | Per-user agent wallets, signing, email identity | Deep: live in Telegram gateway |

## Deadline

2026-05-16 23:59 UTC+8

Submission requires: public GitHub repo, 0G mainnet contract address + Explorer link,
demo video (3 min max), README with architecture diagram, and a public X post.
