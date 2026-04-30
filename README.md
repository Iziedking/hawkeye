# HAWKEYE

Crypto trading agent swarm on Telegram. Users send plain text messages, an LLM classifies the intent, and a network of agents handles safety checks, quoting, execution, and monitoring in parallel over a typed event bus.

Built for the **OpenAgent Hackathon by ethGlobal**.

## How it works

```
Telegram message
  |
  v
LLM Router (0G Compute -> Claude -> regex fallback)
  |
  v
Event Bus (typed, parallel)
  |
  +-- Safety Agent     GoPlus, Honeypot, RugCheck
  +-- Quote Agent      DexScreener, Uniswap Trading API
  +-- Strategy Agent   risk scoring, mode logic
  +-- Execution Agent  Uniswap swap, KeeperHub tx submission
  +-- Monitor Agent    price polling, exit triggers
  +-- Research Agent   alpha scanning, token analysis
  +-- Copy Trade       wallet watching (planned)
```

A bare contract address skips the LLM entirely and hits the bus in under 1ms.

## Repo structure

```
src/
  index.ts                  main startup
  shared/                   event bus, types, env, token resolver, wallet store
  gateway/                  Telegram bot (grammY), LLM router
  integrations/
    0g/                     Compute (LLM) + Storage (audit trail)
    claude/                 fallback LLM
    privy/                  per-user wallets
  tools/                    MCP servers (dexscreener, goplus, gensyn-axl, openclaw-docs)
  agents/                   teammate PRs land here
```

## Setup

```bash
npm ci
cp .env.example .env.local   # fill in required vars
npm start
```

## Env vars

| Variable | Purpose | Required |
|----------|---------|----------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot | Yes |
| `HAWKEYE_EVM_PRIVATE_KEY` | 0G Compute + Storage | Yes |
| `ANTHROPIC_API_KEY` | Claude fallback LLM | Recommended |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Agent wallets | Recommended |
| `UNISWAP_API_KEY` | Quote fallback | Optional |
| `GOPLUS_API_KEY` / `GOPLUS_API_SECRET` | Safety scans | Optional |
| `KH_API_KEY` | KeeperHub MEV protection | Optional |

## Scripts

| Command | What |
|---------|------|
| `npm start` | Run the bot |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run smoke tests |
| `npm run lint` | ESLint |
| `npm run format:check` | Prettier check |

## Sponsor integrations

| Sponsor | Usage | Status |
|---------|-------|--------|
| 0G Compute | LLM router + agent reasoning | Live (Galileo testnet) |
| 0G Storage | On-chain audit trail | Live (Galileo testnet) |
| 0G Chain | Mainnet contract | Pending |
| Gensyn AXL | P2P bus transport | Node + MCP wired |
| KeeperHub | MEV-protected tx submission | MCP wired |
| Uniswap | DEX swaps (Trading API) | Live |
| Privy | Per-user agent wallets | Live |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Branch off `feat/<name>-<feature>`, add your agent under `src/agents/<name>/index.ts`, open a PR.

## License

ISC
