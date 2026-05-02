# HAWKEYE

Autonomous crypto trading agent swarm on Telegram. Seven specialized agents coordinate through a typed event bus to handle the full trade lifecycle: safety checks, quoting, strategy, execution, monitoring, research, and copy trading.

Built for the **0G APAC Hackathon** on HackQuest.

## Architecture

```
                          Telegram
                             |
                      Telegram Gateway (grammy)
                             |
                      LLM Router (0G Compute)
                             |
          +------------------+------------------+
          |                  |                  |
     DEGEN_SNIPE        RESEARCH_TOKEN     GENERAL_QUERY
     TRADE                   |                  |
          |            Research Agent       LLM Response
          |           (DexScreener +       (conversational)
          |          DeFiLlama + Dune)
          |
    TRADE_REQUEST
          |
    +-----+-----+
    |           |
  Safety     Quote
  Agent      Agent
    |           |
    +-----+-----+
          |
     Strategy Agent
          |
     EXECUTE_TRADE
          |
    Execution Agent
   (Uniswap + KeeperHub)
          |
    TRADE_EXECUTED
          |
     Monitor Agent
   (price tracking,
    trailing stops)
```

A bare contract address skips the LLM entirely and hits the bus in under 1ms.

## Agents

| Agent | Responsibility | Data sources |
|---|---|---|
| **Safety** | Token risk scoring, honeypot detection, rug pull analysis | GoPlus, Honeypot.is, RugCheck |
| **Quote** | Price discovery, liquidity depth, routing | DexScreener, Uniswap Trading API |
| **Strategy** | Risk/reward merge, trading mode enforcement, trade decisions | Safety + Quote results |
| **Execution** | On-chain swap submission with MEV protection | Uniswap Trading API, KeeperHub, Privy wallets |
| **Monitor** | Position tracking, exit triggers, trailing stops | DexScreener price polling |
| **Research** | Token analysis, trending discovery, alpha scanning | DexScreener, DeFiLlama, Dune Analytics |
| **Copy Trade** | Wallet watching, trade mirroring | On-chain tx monitoring |

All agents talk exclusively through the event bus. No agent imports another directly.

## Trade lifecycle

```
  0ms    LLM Router classifies intent -> TRADE_REQUEST emitted
  0ms    Safety Agent starts checking the token
  0ms    Quote Agent starts fetching prices
  0ms    0G Audit Trail writes intent to Storage + Chain
 ~1.5s   SAFETY_RESULT comes back
 ~1s     QUOTE_RESULT comes back
 ~1.5s   Strategy Agent has both, makes the call
 ~1.6s   EXECUTE_TRADE emitted
 ~2.5s   Transaction submitted with MEV protection (KeeperHub)
 ~5s     Transaction confirmed on chain
 ~5.1s   Monitor starts watching position with trailing stop
```

## 0G Integration

HAWKEYE uses three 0G components:

- **0G Compute** -- LLM brain. Classifies every user message into intent categories, powers conversational responses, and drives agent analysis. Verified inference via `processResponse()`.
- **0G Storage** -- Immutable audit trail. Writes at 6 lifecycle points (intent, safety, strategy, execution, research, alpha). Each write returns a `rootHash` for on-chain verification.
- **0G Chain** -- On-chain registry. `HawkeyeRegistry` Solidity contract records agent identities and trade execution proofs. `storeIntent()` on every trade, `logTrade()` on every execution.

## Repo structure

```
src/
  index.ts                       main startup, wiring
  shared/                        event bus, types, env, tokens, wallet store, health
  gateway/
    telegram-gateway.ts          primary gateway (grammy)
    llm-router.ts                LLM-first intent classification
  agents/
    safety/                      token risk analysis
    quote/                       price discovery and routing
    strategy/                    trade decision engine
    execution/                   on-chain swap execution
    monitor/                     position tracking and exit triggers
    research/                    token analysis and alpha scanning
    copy-trade/                  wallet watching
  integrations/
    0g/                          Compute, Storage, Registry, audit trail
    openrouter/                  OpenRouter LLM fallback (configurable model)
    claude/                      Claude LLM fallback
    privy/                       per-user agent wallets
    keeperhub/                   MEV-protected tx submission
  tools/                         MCP servers (dexscreener, goplus, gensyn-axl, openclaw-docs)
contracts/
  HawkeyeRegistry.sol           on-chain agent registry + trade proofs
scripts/
  deploy-registry.ts            contract deployment
```

## Setup

```bash
git clone <repo-url> && cd hawkeye
npm install
cp .env.example .env.local       # fill in required vars
npm start                        # starts Telegram bot
```

### Environment variables

| Variable | Purpose | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot via BotFather | Yes |
| `HAWKEYE_EVM_PRIVATE_KEY` | 0G Compute + Storage + Chain | Yes |
| `OPENROUTER_API_KEY` | LLM fallback (any model) | Recommended |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Per-user agent wallets | Recommended |
| `UNISWAP_API_KEY` | Swap routing | Optional |
| `GOPLUS_API_KEY` | Token safety scanning | Optional |
| `KH_API_KEY` | KeeperHub MEV protection | Optional |
| `DUNE_API_KEY` | Smart money flow data | Optional |

See `.env.example` for the full list with descriptions.

## Commands

| Script | What it does |
|---|---|
| `npm start` | Run the bot |
| `npm run typecheck` | Typecheck all modules |
| `npm test` | Run smoke tests |
| `npm run lint` | ESLint |
| `npm run format:check` | Prettier check |

## Telegram commands

| Command | What it does |
|---|---|
| `/start` | Welcome message and setup |
| `/wallet` | Create or view agent wallet |
| `/balance` | Check native balances across 7 chains |
| `/status` | System health and agent status |
| `/help` | Full command guide |

Paste any contract address to trigger an instant trade flow. Natural language queries like "What's trending on Ethereum?" are routed through the LLM to the appropriate agent.

## Sponsor integrations

| Sponsor | Usage | Integration |
|---|---|---|
| **0G** | Compute (LLM), Storage (audit trail), Chain (registry) | Core infrastructure, every message |
| **Gensyn AXL** | P2P bus transport between agent nodes | Event bus bridge, MCP server |
| **KeeperHub** | MEV-protected EVM transaction submission | Execution pipeline with circuit breaker |
| **Uniswap** | DEX swaps via Trading API (3-step flow) | check_approval, quote, swap |
| **Privy** | Per-user agent wallets and signing | Wallet provisioning in gateway |

## On-chain deployments

| Network | Contract | Chain ID |
|---|---|---|
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602 |
| 0G Mainnet | Pending | 16661 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Branch off `feat/<name>-<feature>`, add your agent under `src/agents/<name>/`, open a PR.

## License

ISC
