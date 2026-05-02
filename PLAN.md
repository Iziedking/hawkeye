# HAWKEYE Build Plan

Autonomous crypto trading agent swarm for the OPEN AGENTs HACKATHON.

## Current status (2026-05-01)

All 7 agents built and wired. Telegram gateway live with wallet provisioning, LLM-first
routing, research delivery, and multi-chain balance checking. OpenRouter handles LLM
fallback (configurable model, cheaper than direct API calls). RPC provider is Publicnode
(free, no key).

### Module status

| Module | Path | Status |
|---|---|---|
| Event Bus | `src/shared/event-bus.ts` | Done |
| AXL Bus Transport | `src/shared/axl-bus.ts` | Done (bridges to Gensyn P2P) |
| Shared types | `src/shared/types.ts` | Done |
| Constants | `src/shared/constants.ts` | Done |
| Health system | `src/shared/health.ts` | Done (HTTP and Telegram /status) |
| Token resolver | `src/shared/tokens.ts` | Done |
| Wallet persistence | `src/shared/store.ts` | Done (V2 schema, multi-wallet) |
| Swarm tracer | `src/shared/swarm-tracer.ts` | Done |
| EVM chains | `src/shared/evm-chains.ts` | Done (16 chains, Publicnode RPCs) |
| LLM Router | `src/gateway/llm-router.ts` | Done (trending routing added) |
| Telegram Gateway | `src/gateway/telegram-gateway.ts` | Done (primary gateway) |
| OpenClaw Adapter | `src/gateway/openclaw-adapter.ts` | Reference only |
| OpenRouter LLM | `src/integrations/openrouter/` | Done (configurable model) |
| Privy wallets | `src/integrations/privy/` | Done (multi-wallet, email sign-in) |
| 0G Compute | `src/integrations/0g/compute.ts` | Done (nonce serialization) |
| 0G Storage | `src/integrations/0g/storage.ts` | Done |
| 0G Registry | `src/integrations/0g/registry-client.ts` | Done (runtime logTrade) |
| 0G Audit Trail | `src/integrations/0g/audit-trail.ts` | Done (6 bus events) |
| 0G Balance Check | `src/integrations/0g/shared-signer.ts` | Done (boot warning) |
| KeeperHub | `src/integrations/keeperhub/` | Done (circuit breaker) |
| Arkham Intelligence | `src/integrations/arkham/` | Done (holders, flows, and entity lookup) |
| Safety Agent | `src/agents/safety/` | Done |
| Quote Agent | `src/agents/quote/` | Done |
| Strategy Agent | `src/agents/strategy/` | Done |
| Execution Agent | `src/agents/execution/` | Done (Uniswap 3-step, KeeperHub) |
| Research Agent | `src/agents/research/` | Done (DexScreener, DeFiLlama, Dune, and Arkham) |
| Monitor Agent | `src/agents/monitor/` | Done |
| Copy Trade Agent | `src/agents/copy-trade/` | Done |
| HawkeyeRegistry | `contracts/HawkeyeRegistry.sol` | Deployed to testnet |
| Deploy script | `scripts/deploy-registry.ts` | Done |
| MCP servers | openclaw-docs, dexscreener, goplus, gensyn-axl, coingecko, keeperhub | Done |
| Main startup | `src/index.ts` | Done |

### Architecture

```
User (Telegram / Frontend UI)
  |
  v
Telegram Gateway (grammY)
  |
  v
LLM Router (0G Compute -> OpenRouter -> regex)
  |
  +-- DEGEN_SNIPE/TRADE --> TRADE_REQUEST on bus
  |     |-- Safety Agent (GoPlus, Honeypot, and RugCheck) --> SAFETY_RESULT
  |     |-- Quote Agent (DexScreener and Uniswap) --> QUOTE_RESULT
  |     |-- Strategy Agent (merges safety and quote) --> STRATEGY_DECISION
  |     |-- Execution Agent (Uniswap Trading API, KeeperHub) --> TRADE_EXECUTED
  |     |-- Monitor Agent (polls prices, trailing stops) --> EXECUTE_SELL
  |     `-- 0G Audit Trail (Storage writes and Chain logTrade at every step)
  |
  +-- RESEARCH_TOKEN --> Research Agent (DexScreener, DeFiLlama, Dune, and Arkham) --> RESEARCH_RESULT
  +-- GENERAL_QUERY --> LLM conversational reply
  +-- COPY_TRADE --> Copy Trade Agent (wallet watching)
  +-- PORTFOLIO --> balance check and open positions
  +-- SETTINGS --> session and mode update
  `-- BRIDGE --> bus event and status reply

Bus Transport: EventEmitter (local) <--> Gensyn AXL (P2P)
```

### 0G integration (3 components)

1. **0G Compute** -- LLM brain. Classifies every message, powers conversational replies, and agent analysis. Verified inference via `processResponse()`.
2. **0G Storage** -- Immutable audit trail. Writes at 6 lifecycle points: intent, safety, strategy, execution, research, and alpha. Each write returns a rootHash for verification.
3. **0G Chain** -- On-chain registry. `HawkeyeRegistry` contract records agent identities and trade execution proofs. `storeIntent()` on every trade, `logTrade()` on every execution.

### LLM fallback chain

1. 0G Compute (primary, on-chain verifiable)
2. OpenRouter (configurable model via `OPENROUTER_MODEL` env var, cheaper alternative)
3. Regex-only (last resort, degen snipes still work)

### On-chain deployments

| Network | Contract | Chain ID |
|---|---|---|
| 0G Galileo Testnet | `0x42602be460373479c74AfE461F6f356d0bbE3475` | 16602 |
| 0G Mainnet | Not deployed yet | 16661 |

---

## Emergency Restructure (2026-05-01)

Team, live Telegram testing on April 30 exposed 6 critical failures. I've applied 5 fixes
to the gateway, router, types, strategy, and research agent. You need to update your agents
to match the new type fields and flows. Read this section carefully before touching any code.

### What I changed

1. **`side` field added to TradeIntent** (`src/shared/types.ts`). `side?: "buy" | "sell"`.
   Sell keywords (`sell`, `dump`, `exit`, `close`, `short`) now detected in the degen
   shortcut and LLM router. Gateway shows sell-specific prompts and messages.

2. **DexScreener-first token verification** (`src/gateway/telegram-gateway.ts`). Every trade
   now calls `searchPairs(address)` before showing anything to the user. LLM-provided token
   names are overridden by on-chain data. This fixes the "APE on SePOLIA" hallucination bug
   we saw in testing.

3. **Default exit targets** (`src/gateway/telegram-gateway.ts`). Buy intents now include:
   `[{ target: { kind: "multiplier", value: 2.0 }, percent: 50 }, { target: { kind: "multiplier", value: 5.0 }, percent: 100 }]`.
   This means the Monitor agent will activate on every buy going forward.

4. **Strategy validation gate** (`src/agents/strategy/index.ts`). Before mode logic runs,
   strategy now rejects: chain mismatches (testnet vs mainnet), unexpected testnet resolution,
   and liquidity below $500. This prevents fake buys on the wrong chain.

5. **Combined trending** (`src/agents/research/index.ts`). DexScreener profiles and boosts
   merged with CoinGecko `/search/trending`. Deduped, filtered, and sorted by volume.
   Trending now shows tokens that are actually trending, not random CoinGecko category results.

### New type fields you must use

```typescript
// TradeIntent -- new field
side?: "buy" | "sell"

// Quote -- new fields (Sunday populates these)
tokenName?: string
tokenSymbol?: string
```

---

## Your Task Assignments

Work ONLY in your agent's folder. Do not touch `src/shared/types.ts`, `src/gateway/`, or
`src/index.ts` -- I handle those to prevent merge conflicts. Pull latest before you start.

### Sunday -- Quote Agent (`src/agents/quote/index.ts`)

**Task 1: Populate `tokenName` and `tokenSymbol` in QUOTE_RESULT**

I added `tokenName?: string` and `tokenSymbol?: string` to the Quote type. You need to set
them from the DexScreener pair data you already fetch. The `pair` variable from
`resolveBestPair()` has `pair.baseToken.name` and `pair.baseToken.symbol`. Add them before
emitting QUOTE_RESULT:

```typescript
tokenName: pair.baseToken?.name ?? undefined,
tokenSymbol: pair.baseToken?.symbol ?? undefined,
```

**Task 2: Multi-chain fallback**

When `resolveBestPair()` returns null for the preferred chain, try other mainnet chains
before failing. Try base, ethereum, arbitrum, bsc, polygon, optimism, avalanche in parallel
using `Promise.allSettled`. Return the pair with highest liquidity.

**Task 3: CoinGecko price cross-check**

Add a best-effort CoinGecko price lookup alongside DexScreener. If both return prices, use
the average. If only one returns, use that. Don't let CoinGecko failure block the quote.

### Joshua -- Safety Agent (`src/agents/safety/` ONLY)

**Task 1: Expand TESTNET_CHAIN_IDS**

Line 39 only has `"sepolia"`. Add: `"base-sepolia"`, `"goerli"`, `"mumbai"`, `"fuji"`,
`"basesepolia"`.

**Task 2: Multi-chain Etherscan support**

`checkEtherscan()` only works on Ethereum mainnet. Add support for:
- Base: `api.basescan.org`
- Arbitrum: `api.arbiscan.io`
- BSC: `api.bscscan.com`
- Polygon: `api.polygonscan.com`

All use the same Etherscan API format. Map `chainId` to the correct base URL.

**Task 3: Return `resolvedChainId` in SAFETY_RESULT**

I will add `resolvedChainId?: string` to SafetyReport if needed. Set it to whatever chain
DexScreener resolved the token to.

### Sunday -- Execution Agent (`src/agents/execution/index.ts`)

I already added sell routing in `handleExecute()` that checks `intent.side === "sell"`,
finds the user's position, and calls `handleSell()`. Your work improves the execution
quality around this.

**Task 1: Position lookup by token address**

Add a helper `findPositionByAddress(userId: string, tokenAddress: string)` that searches
`positionStore` for active positions matching the user and token. The sell flow needs this.

**Task 2: Improve swap error messages**

`humanizeQuoteError()` handles some cases. Add more:
- `INSUFFICIENT_BALANCE` -> "Not enough ETH in your wallet for this trade"
- `TOKEN_NOT_TRADEABLE` -> "This token can't be traded on Uniswap right now"
- `NO_ROUTE` -> "No swap route found. The token may have no liquidity on Uniswap"
- `PRICE_IMPACT_TOO_HIGH` -> "Price impact too high. Try a smaller amount"

**Task 3: Verify TRADE_EXECUTED includes position data**

After successful execution, make sure the emitted Position has `remainingExits` from the
intent, `entryPriceUsd` from the quote, and `filledAmount` from the execution receipt.
Monitor agent needs all three to track the position properly.

---

## PR Rules

1. Each PR modifies ONLY files in your agent's folder (`src/agents/<name>/`)
2. Do NOT modify `src/shared/types.ts`, `src/gateway/`, or `src/index.ts`
3. Pull latest from main before starting
4. Test with `npx tsc -p src/agents/<name>/tsconfig.json --noEmit`
5. If your agent doesn't have a scoped tsconfig, create one that extends the root

---

## What needs to be done before May 3

- [ ] Live Telegram testing of all 5 emergency fixes
- [ ] Deploy 0G mainnet contract (requires funded mainnet wallet)
- [ ] Real transaction testing on mainnet (small amounts on Base/Arbitrum)
- [ ] KeeperHub processes every trade with evidence (tx protection proof)
- [ ] Gensyn P2P agent communication working for demo
- [ ] All three modes (degen/normal/safe) tested and working with quality
- [ ] Testnet trades work (no fake USD values attached to testnet tokens)
- [ ] Mainnet trades work with real swap routes (Uniswap covers 17+ EVM chains)
- [ ] Monitor agent activates on every buy and tracks positions
- [ ] Trade confirmation UX (inline keyboards for confirm/reject)
- [ ] Copy trade user commands (/watch, /unwatch, /watchlist)
- [ ] Trading mode commands (/mode degen, /mode normal, /mode safe)
- [ ] Portfolio with open positions and PnL display
- [ ] Gensyn AXL cross-node demo (two AXL nodes communicating)
- [ ] Frontend UI (Stephanie's build)
- [ ] Demo video (3 min max)
- [ ] Public X post
- [ ] README with architecture diagram

## Env vars

Copy `.env.example` to `.env.local` and fill in. See `.env.example` for the full list.

## Sponsors

| Sponsor | What we use | Integration |
|---|---|---|
| 0G Compute | LLM router, conversational replies, and agent analysis | Every message routed through 0G |
| 0G Storage | Immutable audit trail at 6 lifecycle points | Every trade fully logged |
| 0G Chain | On-chain agent registry and trade execution proofs | Runtime logTrade calls |
| Gensyn AXL | P2P bus transport between agent nodes | Agent-to-agent communication |
| KeeperHub | MEV-protected EVM tx submission | Every trade with protection evidence |
| Uniswap | DEX swaps via Trading API (3-step, 17 chains) | check_approval, quote, and swap |
| Privy | Per-user agent wallets, signing, and email identity | Wallet creation and tx signing |
| Arkham | Wallet analytics, smart money tracking, and entity research | Token holders and flow analysis |

## Deadline

2026-05-03 23:59 UTC+8

Public GitHub repo, 0G mainnet contract address and Explorer link, demo video (3 min max),
README with architecture diagram, public X post.
