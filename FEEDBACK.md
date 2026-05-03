# Builder feedback — Uniswap Trading API

Submitted for the Uniswap Foundation track at the OpenAgents hackathon.
This is the candid integration experience from building HAWKEYE's Execution
agent on the Uniswap Trading API.

## Where Uniswap shows up in HAWKEYE

The entire on-chain trade execution layer (`src/agents/execution/index.ts`)
is built on three Uniswap Trading API endpoints:

1. `POST /check_approval` — pre-flight Permit2 / ERC20 approval check
2. `POST /quote` — route + slippage + gas estimate
3. `POST /swap` — execute the prepared swap

That sequence handles every EVM swap across 17+ chains (Ethereum, Base,
Arbitrum, Optimism, Polygon, BSC, etc.). When the wallet doesn't have the
required allowance, we submit the approval transaction returned by
`/check_approval` first, then re-quote and swap.

We also use the Uniswap AI swap-planning skills under `.agents/skills/` for
prompt-engineering hints inside the LLM router.

## What worked really well

- **Routing-aware response shape** — having `routing: "CLASSIC" | "DUTCH_V2" | "DUTCH_V3" | "PRIORITY"` in the quote response let us write a single `isUniswapXRoute()` helper and branch Permit2 handling cleanly. We didn't have to detect the route type from heuristics.
- **`/check_approval` returns the literal approval tx** ready to sign. Compared to having to construct an ERC20 approve calldata ourselves with the right Permit2 spender, this is a huge DX win.
- **Cross-chain consistency.** Same three endpoints, same payload shape, parameterized by `chainId`. We wired up 17+ chains in a single afternoon. The fact that `tokenInChainId` and `tokenOutChainId` are passed as strings even though they're numeric was the only oddity, but consistent across the API.
- **Universal Router version pinning** via the `x-universal-router-version` header gave us confidence that calldata stays compatible. We pin `2.0`.

## What didn't work / friction we hit

### 1. `/check_approval` doesn't tell you which spender it's approving for

When the response is `{ approval: { to, data, value } }`, the `to` is sometimes
the Permit2 contract and sometimes the Universal Router. We only learn which
when the swap step succeeds or fails. A `spender` or `approvalType` field on
the response would let us reason about whether to set max-approval vs exact.

### 2. Permit2 signature attachment is under-documented

For UniswapX routes (`DUTCH_V2` / `DUTCH_V3` / `PRIORITY`), the swap step needs
`signature: "0x..."` at the top level. For CLASSIC routes that need a permit,
the swap step needs both `signature` AND the original `permitData` echoed back.
For CLASSIC routes that already have on-chain approval, neither is needed —
but `permitData` is still in the quote response if the user _could_ benefit
from a permit, and you must NOT send it back.

We learned this by trial and error against testnets. A single page in the docs
covering "what to do with `permitData` and `permitTransaction` based on route
type" would have saved us hours. Suggested doc layout:

```
| route type        | permitData on quote | sig required at swap | permitData echoed at swap |
| ----------------- | ------------------- | -------------------- | ------------------------- |
| CLASSIC, no approval needed | absent     | no                   | n/a                       |
| CLASSIC, ERC20 approve done | absent     | no                   | n/a                       |
| CLASSIC, signed permit      | present    | yes                  | yes                       |
| DUTCH_V2 / V3 / PRIORITY    | absent     | yes (off-chain order)| no                        |
```

### 3. `gasFeeUSD` only on CLASSIC routes

For UniswapX routes, the response gives `orderInfo.outputs[0].startAmount` but
no consolidated gas estimate (because UniswapX is gasless to the user). That's
correct, but you have to know to look in two completely different places for
"how much will this cost?". A unified `cost` block on every route type with
`{ gasUsd?, fillerFeeUsd?, expectedOutAmount }` would let us write one cost
display path instead of two.

### 4. Empty `swap.data === "0x"` doesn't surface as an error

We hit this once and submitted a transaction with empty calldata. We now
guard with `validateSwapResponse` (`src/agents/execution/index.ts:198`).
Returning `{ error: "QUOTE_EXPIRED" }` instead of an empty swap object would
have caught it cleanly upstream.

### 5. No batched balance/approval pre-check

We currently make a separate `fetchTokenBalance` RPC call before the Uniswap
flow to avoid the most common revert ("you don't hold this token"). A
`POST /preflight` endpoint that takes `{ swapper, tokenIn, amountRaw, chainId }`
and returns `{ has_balance, has_approval, would_exceed_slippage }` would let
agents fail fast without round-tripping multiple endpoints.

### 6. Error messages are JSON.stringify-friendly but not human-friendly

Errors come back as `{ errorCode, detail, ... }` which is great for parsing,
but the `detail` is often something like `"INSUFFICIENT_LIQUIDITY"` that
doesn't map cleanly to "what should the user do?". We wrote a
`humanizeQuoteError(status, raw)` function (`src/agents/execution/index.ts:63`)
to translate codes into actionable messages — could that translation table
live in the Uniswap docs / SDK?

### 7. Single-token-per-call constraint on DexScreener-style search

Not Uniswap's surface, but related: the LLM has to resolve `"PEPE on Base"` to
a contract address before calling Uniswap. We do this via DexScreener which
only accepts a single search token. A Uniswap "token resolver" that took
`{ symbol, chainId }` and returned the canonical Uniswap-listed contract
would close a big gap (and let agents skip a third-party dependency).

## Bugs we hit

- One transient `400 Bad Request` from `/quote` with an empty `detail` field.
  Re-running with the same payload worked. Likely transient, but a stable
  error code would help us decide whether to retry or escalate.
- `/swap` returned `200 OK` with `swap.value: undefined` for one Optimism
  request. We default to `"0"` (`src/agents/execution/index.ts:402`) but a
  guarantee that `swap.value` is always a string `"0"` minimum would let us
  drop the defensive code.

## Docs gaps we noticed

- No public reference for `routingPreference` other than `"BEST_PRICE"`. We
  use `BEST_PRICE` everywhere; would `LOW_GAS` or `STABLE_PAIR_PREFERENCE` do
  what we'd hope?
- The `x-universal-router-version` header is required but I had to find it
  in a Discord answer rather than in the docs.
- No code sample for "how to retry a swap after the user signs the approval"
  (i.e., the two-step approve-then-swap flow). We wrote our own; the official
  pattern would be useful for new builders.

## What I wish existed

1. **`POST /preflight`** — combined balance + approval + slippage check (above).
2. **Webhook for swap status** — we currently poll explorers via the wallet
   manager. A webhook that fires `confirmed` / `failed` would let us close
   the trade-execution loop faster and avoid polling.
3. **Streaming quote endpoint** — for large trades on volatile pairs, a
   server-sent-events stream of price updates would let agents wait for
   improvement before committing.
4. **First-class agent identity** — `swapper` is just an EOA today. If the
   API accepted `swapper: { kind: "smart_account", ownerAddr, accountAddr }`
   we could integrate ERC-4337 smart accounts (Privy embedded wallets, etc.)
   without manually wrapping calldata.

## DX friction summary

- Onboarding required reading three different doc pages (Trading API, Permit2
  guide, UniswapX overview) to understand the swap response shape. A single
  "Building agents on the Trading API" guide would consolidate.
- Auth via `x-api-key` header is fine, but no clear rate-limit headers in the
  response. We had to guess at retry-after behavior.
- The `swapper` field name is non-obvious for first-time users — `walletAddress`
  or `traderAddress` would have been more discoverable.

## What we built on top

For reference: we use the Trading API as the execution backbone of a 7-agent
trading swarm where one of the agents (Strategy) decides whether to execute
based on safety scores from GoPlus + Honeypot.is, and another (Monitor) emits
sell triggers when take-profit / stop-loss thresholds hit. Uniswap is the only
DEX integration in the stack.

Repo: https://github.com/Iziedking/hawkeye
Path of interest: `src/agents/execution/index.ts`
