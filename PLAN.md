# HAWKEYE Build Plan

Autonomous crypto trading agent swarm for the 0G APAC Hackathon, Track 2 (Agentic Trading Arena).

## What's already shipped

The core infrastructure is live. Event bus, intent parser, gateway, 0G integrations, and all MCP tooling are tested and working. Everything below was built and verified before the team started cloning.

| Module | Path |
|--------|------|
| Event Bus | `src/shared/event-bus.ts` |
| Shared types | `src/shared/types.ts` |
| Env loader | `src/shared/env.ts` |
| Intent Parser | `src/gateway/intent-parser.ts` |
| OpenClaw Adapter | `src/gateway/openclaw-adapter.ts` |
| Gateway wiring | `src/gateway/index.ts` |
| 0G Compute client | `src/integrations/0g/compute.ts` |
| 0G Storage client | `src/integrations/0g/storage.ts` |
| MCP servers | openclaw-docs, dexscreener, goplus, gensyn-axl, coingecko, keeperhub |
| Uniswap skills | `.agents/skills/` |

## What each person is building

### Israel Dominic (Lead Dev)

I own `src/shared/`, `src/gateway/`, and `src/integrations/`. My remaining work:

- [ ] Strategy Agent (`src/agents/strategy.ts`) — takes SAFETY_RESULT and QUOTE_RESULT, applies trading mode logic, emits EXECUTE_TRADE or asks the user to confirm
- [ ] Main startup (`src/index.ts`) — boots every agent and connects the bus
- [ ] Gensyn AXL bus swap (`src/shared/axl-bus.ts`) — replace the local EventEmitter with P2P transport
- [ ] 0G Chain mainnet contract deploy (required for submission)

I also review and merge every PR.

### Sunday Enejo (Execution and Chain)

You own `src/agents/execution.ts` and `src/agents/quote.ts`.

- [ ] Quote Agent — listen for TRADE_REQUEST, fetch prices using GOAT SDK (Jupiter on Solana, Uniswap on EVM), emit QUOTE_RESULT
- [ ] Execution Agent — listen for EXECUTE_TRADE, submit the on-chain transaction with MEV protection (Flashbots for EVM, Jito for Solana), emit TRADE_EXECUTED
- [ ] Wire KeeperHub for gas management
- [ ] Add transaction simulation before executing

Read `CONTRIBUTING.md` first. Your entry point:
```typescript
bus.on("TRADE_REQUEST", async (intent) => {
  // fetch quote, then:
  bus.emit("QUOTE_RESULT", quote);
});
```

MCPs you'll use: dexscreener, coingecko, keeperhub, and the Uniswap skills.

### Samuel Chukwu (Safety and Data)

You own `src/agents/safety.ts` and `src/agents/research.ts`.

- [ ] Safety Agent — listen for TRADE_REQUEST, run GoPlus and Honeypot and RugCheck in parallel, emit SAFETY_RESULT with a score out of 100
- [ ] Research Agent — background loop that polls DexScreener trending every 30 seconds, emits ALPHA_FOUND when something interesting shows up
- [ ] Token cache so we don't re-scan the same token within 5 minutes

Read `CONTRIBUTING.md` first. Your entry point:
```typescript
bus.on("TRADE_REQUEST", async (intent) => {
  // run parallel safety checks, then:
  bus.emit("SAFETY_RESULT", report);
});
```

MCPs you'll use: goplus, dexscreener, coingecko.

### Olanrewaju Joshua (Monitor and Copy Trade)

You own `src/agents/monitor.ts` and `src/agents/copy-trade.ts`.

- [ ] Monitor Agent — listen for TRADE_EXECUTED, spawn one price watcher per position, emit EXECUTE_SELL when an exit target is hit
- [ ] Copy Trade Agent — maintain WebSocket subscriptions to watched wallets, emit COPY_TRADE_REQUEST when a wallet swaps

Read `CONTRIBUTING.md` first. Your entry point:
```typescript
bus.on("TRADE_EXECUTED", async (position) => {
  // spawn a watcher, when target hit:
  bus.emit("EXECUTE_SELL", { positionId, fraction, triggeredBy });
});
```

MCPs you'll use: dexscreener, coingecko.

### Stephanie Egede (Frontend)

You own the dashboard, either in `src/frontend/` or a separate repo.

- [ ] React dashboard showing portfolio, trade history, and live P&L for active positions
- [ ] Connect to event bus output events for real-time updates
- [ ] Record the demo video (3 min max)

You can start now. All the event types you need are defined in `src/shared/types.ts`.

## How it all connects

When someone pastes a contract address, this happens:

```
0ms    Intent parsed, TRADE_REQUEST emitted
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

## Branch rules

Work on feature branches named `feat/<your-name>-<what>`. For example `feat/sunday-quote-agent` or `feat/samuel-safety-agent`. Push your branch, open a PR into main. I'll review it.

Do not push directly to main. Smoke tests must pass before I merge.

## Sponsors

| Sponsor | What we use it for | Status |
|---------|-------------------|--------|
| 0G Compute | LLM inference in the intent parser | Live on Galileo testnet |
| 0G Storage | On-chain audit trail for every parsed intent | Live on Galileo testnet |
| 0G Chain | Mainnet contract (required for submission) | Not deployed yet |
| Gensyn AXL | P2P bus transport between agents | Node built, MCP wired |
| KeeperHub | EVM transaction execution and gas management | MCP wired, ready to use |
| Uniswap | DEX integration for EVM swaps | Skills installed, ready to use |

please take on ore build that you can (the build is really wide what you are seeing now is phase one; remeber we need to spawn research agent consistently online, create tool that support bridging, liquidity monitoring and provision, polymarket support, copy trading, smart monry flows. also if you have more functionalities and suggestion, you are free to always update the notion page and also call for meetups)

## Deadline

2026-05-03 23:59 UTC+8

Submission requires: public GitHub repo, 0G mainnet contract address, demo video (3 min max), README with architecture diagram, and a public X post.
