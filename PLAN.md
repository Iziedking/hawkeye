# HAWKEYE Build Plan

Autonomous crypto trading agent swarm for the OpenAgent Hackathon by ethGlobal.

## Current status (as of 2026-04-29)

The core infrastructure is built and live-tested via Telegram. The LLM router classifies every message, the bot responds intelligently, and all bus events are wired. Agents are not in this repo yet. Each teammate builds their agents on a feature branch and PRs them in.

### What's in this repo (Israel's deliverables)

| Module              | Path                                                                 | Status                                                   |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| Event Bus           | `src/shared/event-bus.ts`                                            | Done                                                     |
| Shared types        | `src/shared/types.ts`                                                | Done (includes LlmClient, chainHint, sepolia)            |
| Token resolver      | `src/shared/tokens.ts`                                               | Done (known tokens + DexScreener fallback)               |
| Wallet persistence  | `src/shared/store.ts`                                                | Done (JSON file store in data/users.json)                |
| Swarm tracer        | `src/shared/swarm-tracer.ts`                                         | Done (timestamps all bus events for parallel visibility) |
| LLM Router          | `src/gateway/llm-router.ts`                                          | Done (degen shortcut + 0G/Claude LLM + regex fallback)   |
| Telegram Gateway    | `src/gateway/telegram-gateway.ts`                                    | Done (primary gateway, full UX)                          |
| OpenClaw Adapter    | `src/gateway/openclaw-adapter.ts`                                    | Done (reference, not active)                             |
| Claude LLM fallback | `src/integrations/claude/`                                           | Done (FallbackLlmClient: 0G primary, Claude secondary)   |
| Privy wallets       | `src/integrations/privy/`                                            | Done (per-user agent wallets, external wallet connect)   |
| 0G Compute          | `src/integrations/0g/compute.ts`                                     | Done                                                     |
| 0G Storage          | `src/integrations/0g/storage.ts`                                     | Done                                                     |
| Main startup        | `src/index.ts`                                                       | Done (central LLM, gateway, graceful shutdown)           |
| MCP servers         | openclaw-docs, dexscreener, goplus, gensyn-axl, coingecko, keeperhub | Done                                                     |

### What's NOT in this repo yet (teammates build and PR these)

| Module             | Owner         | Status        |
| ------------------ | ------------- | ------------- |
| Safety Agent       | Samuel        | Not submitted |
| Quote Agent        | Sunday        | Not submitted |
| Strategy Agent     | Sunday/Israel | Not submitted |
| Research Agent     | Samuel        | Not submitted |
| Execution Agent    | Sunday        | Not submitted |
| Monitor Agent      | Joshua        | Not submitted |
| Copy Trade Agent   | Joshua        | Not built     |
| Frontend Dashboard | Stephanie     | Not built     |

### Architecture changes since the original plan

1. **LLM-first router**: Every message goes through the LLM. The old regex parser only handled "has address = trade, else = error". Now HAWKEYE classifies into 10 intent categories and always responds intelligently. Degen snipes still skip the LLM for speed.

2. **Central LLM with fallback**: One `FallbackLlmClient` instance (0G Compute primary, Claude API or OPENROUTER secondary) is created at startup and injected into agents via deps. If both fail, agents fall back to static logic.

3. **Telegram gateway**: Replaced OpenClaw with direct grammY bot. Full control over UX, wallet commands, trade flow, research responses.

4. **Token resolution**: "Swap ETH to USDC on Base" now works. The gateway resolves token names to addresses via a known-tokens table (7 chains) + DexScreener search fallback.

5. **Testnet handling**: Safety agent should auto-pass testnet chains (score=100). Strategy should show a clear testnet message instead of cryptic errors.

6. **Race condition fix**: When wiring agents in `src/index.ts`, Strategy agent MUST start BEFORE Safety/Quote. It needs to register its TRADE_REQUEST handler first so it records the trade before a safety cache hit emits synchronously.

## What each person should do

### Israel Dominic (Lead Dev) — remaining work

- [ ] Gensyn AXL bus swap (`src/shared/axl-bus.ts`) — replace EventEmitter with P2P transport
- [ ] 0G Chain mainnet contract deploy (required for submission)
- [ ] Wire agents into `src/index.ts` once PRs are merged
- [ ] Real transaction testing on mainnet (small amounts on Base/Arbitrum)
- [ ] Submission artifacts: README with architecture diagram, demo video (3 min max), FEEDBACK.md
- [ ] Public X post announcing the project

### Sunday Enejo (Execution and Chain)

You need to build and PR two agents: Quote and Execution.

**Quote Agent** — Create `src/agents/quote/index.ts`

The working version is in hawkeye-build. Your agent should:

- Listen for `TRADE_REQUEST` on the bus
- Fetch price via DexScreener (primary) + Uniswap Trading API (fallback)
- Emit `QUOTE_RESULT` with price, slippage estimate, gas fee
- Export `startQuoteAgent(deps)` that returns a cleanup function

Dependencies available: `ethers`, DexScreener MCP. The `UNISWAP_API_KEY` env var is optional.

Improvements to make on top of the lab version:

- [ ] Replace rough gas fee estimates with real gas price fetches (e.g. via ethers.js provider)
- [ ] Add Jupiter integration for Solana quotes
- [ ] Improve slippage model with actual pool depth data
- [ ] Add more chains to the Uniswap fallback (currently covers 6 mainnet chains)

**Execution Agent** — Create `src/agents/execution/index.ts`

The working version is in hawkeye-build. Your agent should:

- Listen for `STRATEGY_DECISION` with decision=EXECUTE
- Needs both the original `TradeIntent` (cache from `TRADE_REQUEST`) and the `Quote` (cache from `QUOTE_RESULT`)
- Run Uniswap Trading API 3-step flow: check_approval, quote, swap
- Emit `TRADE_EXECUTED` on success
- Export `startExecutionAgent()` that returns `{ stop() }`

Improvements:

- [ ] Wire real KeeperHub MCP for MEV-protected transaction submission (replace `keeperHubStub`)
- [ ] Add transaction simulation before executing (dry-run for reverts)
- [ ] Add Jupiter/Jito execution path for Solana
- [ ] Implement proper ETH price fetching instead of hardcoded $3000 in `toWei()`

**Key invariant**: The Execution Agent caches intents and quotes in maps keyed by intentId. Both TRADE_REQUEST and QUOTE_RESULT must be cached before STRATEGY_DECISION arrives.

### Samuel Chuku (Safety and Data)

You need to build and PR two agents: Safety and Research.

**Safety Agent** — Create `src/agents/safety/index.ts`

The working version is in hawkeye-build. Your agent should:

- Listen for `TRADE_REQUEST` on the bus
- Run GoPlus + Honeypot (EVM) or GoPlus + RugCheck (Solana) in parallel
- Emit `SAFETY_RESULT` with score (0-100) and flags array
- 5-minute cache to avoid repeat calls
- Auto-pass testnet chains (score=100, skip API calls)
- Export `startSafetyAgent()` that returns a cleanup function

Improvements:

- [ ] Add more safety checks: contract age, holder concentration, deployer history
- [ ] Weight safety scores by source reliability
- [ ] Add Solana-specific checks beyond GoPlus + RugCheck
- [ ] Rate limit handling for GoPlus (currently silently fails on 429)

**Research Agent** — Create `src/agents/research/index.ts`

The working version is in hawkeye-build. Your agent should:

- Reactive mode: listen for `RESEARCH_REQUEST`, gather DexScreener + GoPlus data, emit `RESEARCH_RESULT`
- Proactive mode: poll DexScreener boosts/profiles every 30s, score alpha signals, emit `ALPHA_FOUND`
- LLM-enhanced summaries when an LLM client is available (passed via deps)
- Export `startResearchAgent(deps)` that returns `{ stop() }`

Improvements:

- [ ] Add holder analysis (top holders, whale movements)
- [ ] Add social signals (Twitter mentions, Telegram group activity)
- [ ] Add historical price context (not just 1h/24h change)
- [ ] Tune alpha thresholds (current: $10k min liquidity, $5k min volume, >50 safety)

**Key invariant**: DexScreener is always the first call for chain resolution. Never hardcode chain IDs. The chain-ID map is in `src/shared/types.ts` (CHAIN_IDS array).

### Olanrewaju Joshua (Monitor and Copy Trade)

You need to build and PR two agents: Monitor and Copy Trade.

**Monitor Agent** — Create `src/agents/monitor/index.ts`

The working version is in hawkeye-build. Your agent should:

- Listen for `TRADE_EXECUTED` to track open positions
- Poll DexScreener prices for each open position
- Emit `EXECUTE_SELL` when exit targets hit (stop loss, take profit, multiplier)
- Track peak price for trailing stops
- Export `startMonitorAgent()` that returns `{ stop() }`

Improvements:

- [ ] Add trailing stop loss (the `peakPriceUsd` tracking is there, but no trailing stop exit logic yet)
- [ ] Add FDV and market cap exit targets (currently returns false — needs total supply data)
- [ ] Add position alerting via bus events (e.g. significant PnL milestones)
- [ ] Batch price polling for multiple positions on the same token

**Copy Trade Agent** — Create `src/agents/copy-trade/index.ts`

This is NOT in hawkeye-build. You build it from scratch:

- [ ] Listen for `COPY_TRADE_REQUEST` events from the bus
- [ ] Track watched wallets via on-chain event monitoring (Etherscan API or direct RPC)
- [ ] When a watched wallet swaps, emit `TRADE_REQUEST` with the same parameters
- [ ] Add configurable filters: min trade size, token whitelist/blacklist, delay before copying

**Key invariant**: Monitor Agent never executes sells. It only emits `EXECUTE_SELL`. The Execution Agent handles the on-chain side. Keep this separation.

### Stephanie Egede (Frontend)

- [ ] React dashboard showing portfolio, trade history, and live PnL for active positions
- [ ] Connect to event bus output events for real-time updates (WebSocket bridge or polling)
- [ ] Record the demo video (3 min max)

All event types you need are in `src/shared/types.ts`. The key events to display:

- `TRADE_EXECUTED` — new position opened
- `POSITION_UPDATE` — live price + PnL
- `EXECUTE_SELL` — exit triggered
- `ALPHA_FOUND` — research agent found something interesting
- `SAFETY_RESULT` — token safety scan results

## How it all connects

Every user message hits the LLM Router, which classifies it into one of 10 intent categories. The router has a degen shortcut: bare contract addresses (with or without "ape"/"buy") skip the LLM entirely for sub-millisecond speed.

**Degen snipe / Trade flow** (bare CA or explicit trade):

```
0ms    LLM Router -> DEGEN_SNIPE/TRADE -> TRADE_REQUEST emitted
0ms    Safety Agent starts checking the token
0ms    Quote Agent starts fetching prices
~1.5s  SAFETY_RESULT comes back
~1s    QUOTE_RESULT comes back
~1.5s  Strategy Agent has both, makes the call
~1.6s  EXECUTE_TRADE emitted
~2.5s  Transaction submitted with MEV protection
~5s    Transaction confirmed on chain
~5.1s  TRADE_EXECUTED emitted, monitor starts watching
~5.1s  User gets a message with entry price and tx hash
```

**Research flow** (CA + question like "is this safe?"):

```
~2s    LLM Router -> RESEARCH_TOKEN -> RESEARCH_REQUEST emitted
       Research Agent runs DexScreener + GoPlus + safety scan
       User gets a summary with safety score, liquidity, and price data
```

**Conversational flow** (general questions, market queries, unknown):

```
~2s    LLM Router -> GENERAL_QUERY/UNKNOWN
       Second LLM call with conversational prompt
       User gets an intelligent crypto-native response
```

## How to submit your agent

1. Clone this repo
2. Create a branch: `feat/<your-name>-<what>` (e.g. `feat/sunday-quote-agent`)
3. Create your agent folder under `src/agents/<agent-name>/index.ts`
4. Your agent must export a start function that subscribes to bus events and returns a cleanup
5. Test locally: copy your agent into hawkeye-build alongside the other agents and run `npx tsx src/index.ts`
6. Push your branch, open a PR into main
7. Do not push directly to main

Once PRs are merged, I'll wire the agents into `src/index.ts`.

## Env vars needed

Copy `.env.example` to `.env.local` and fill in:

```
TELEGRAM_BOT_TOKEN=       # Required: Telegram bot via BotFather
OG_PRIVATE_KEY=           # Required: 0G Compute + Storage
OG_PROVIDER_URL=          # Required: 0G RPC
ANTHROPIC_API_KEY=        # Recommended: Claude fallback LLM
PRIVY_APP_ID=             # Recommended: agent wallets
PRIVY_APP_SECRET=         # Recommended: agent wallets
UNISWAP_API_KEY=          # Optional: Uniswap Trading API fallback quotes
GOPLUS_KEY=               # Optional: GoPlus MCP
GOPLUS_SECRET=            # Optional: GoPlus MCP
KH_API_KEY=               # Optional: KeeperHub MCP
OPENCLAW_GATEWAY_TOKEN=   # Optional: OpenClaw (legacy gateway)
```

## Sponsors

| Sponsor    | What we use it for                                     | Status                             |
| ---------- | ------------------------------------------------------ | ---------------------------------- |
| 0G Compute | LLM router + conversational responses + agent analysis | Live on Galileo testnet            |
| 0G Storage | On-chain audit trail for every parsed intent           | Live on Galileo testnet            |
| 0G Chain   | Mainnet contract (required for submission)             | Not deployed yet                   |
| Gensyn AXL | P2P bus transport between agents                       | Node built, MCP wired              |
| KeeperHub  | EVM transaction execution and gas management           | MCP wired, stub in Execution Agent |
| Uniswap    | DEX integration for EVM swaps (Trading API)            | Used in Quote + Execution agents   |
| Privy      | Per-user agent wallets, signing, tx submission         | Live in Telegram gateway           |

## Deadline

2026-05-03 23:59 UTC+8

Submission requires: public GitHub repo, 0G mainnet contract address, demo video (3 min max), README with architecture diagram, and a public X post.

Phase 2 scope if there is time: bridging, LP provision, Polymarket support, smart money flows, copy trading execution, persistent user settings, multi-turn conversation context.
