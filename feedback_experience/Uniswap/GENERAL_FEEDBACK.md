# FEEDBACK.md

Builder feedback for the Uniswap Developer Platform and Trading API.

## What we built

HAWKEYE's Execution Agent uses the Uniswap Trading API for all EVM swap execution. The 3-step flow (check_approval, quote, swap/order) routes through the Universal Router v2.0. We target 6 EVM chains: Ethereum, Base, Arbitrum, Optimism, Polygon, and BSC.

## What worked well

The Trading API's structure is clean and predictable. The quote endpoint returning the routing type (CLASSIC vs UniswapX) lets our agent branch logic early. We originally planned separate routing logic per chain but the API handles cross-chain routing internally.

The `x-universal-router-version: 2.0` header requirement being consistent across all API calls was a good design choice. Made it obvious which router version we were targeting without burying it in the request body.

Permit2 integration for token approvals is solid. The check_approval endpoint telling us exactly what approvals are needed before the swap saves a round-trip and prevents reverts from insufficient allowances.

The supported chains list is comprehensive (17+ chains including Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, zkSync, Linea, Blast, and more). We only needed fallback routing for Fantom.

## Pain points

**1. Quote failures return a generic 404 with no root cause.** When we passed a token address with no Uniswap liquidity, the API returned 404 "No quotes available" with no indication whether the issue was a missing pool, insufficient liquidity, or an unsupported token. We added DexScreener as a pre-check to verify pool existence before calling the Trading API. A more specific error (e.g. `NO_POOL_FOUND` vs `INSUFFICIENT_LIQUIDITY` vs `UNSUPPORTED_TOKEN`) would save significant debugging time.

**2. UniswapX vs CLASSIC routing requires completely different execution paths.** This was our biggest integration surprise. UniswapX routes go through `/order` (gasless, solver-filled), while CLASSIC routes go through `/swap` (gasful, integrator-submitted). Our Execution Agent initially treated them as the same endpoint with different payloads, which failed. The getting-started guide could benefit from a more prominent callout that these are fundamentally different flows requiring separate code paths, not just different response fields.

**3. No WebSocket or streaming endpoint for real-time price updates.** Our Monitor Agent polls DexScreener for live prices because the Trading API is request-response only. A streaming price feed for active positions would be valuable for trading agents that need to react to price movements quickly.

**4. The 6 req/s default rate limit is tight for multi-agent systems.** We found the rate limit documented in the common-errors page, but hit it during testing when our Quote Agent and Research Agent both fired concurrent requests. For agent swarms running multiple token analyses in parallel, a documented path to higher limits (or a batch quote endpoint) would help.

## Feature requests

- Batch quote endpoint for multiple token pairs in one request (useful for portfolio rebalancing and multi-token analysis)
- Simulated execution mode (dry-run that returns expected output without submitting)
- Price impact percentage in the quote response (we calculate it manually from liquidity data)
- Webhook for swap confirmation instead of polling the tx hash

## SDK feedback

The existing TypeScript SDKs (v2, v3, v4, sdk-core) are great for direct protocol interaction. What we'd find valuable is a Trading API client SDK that wraps the REST endpoints with typed request/response objects and handles the CLASSIC vs UniswapX flow branching automatically. We built this ourselves with fetch() but a first-party version would reduce integration time for new builders.

## Overall

The Uniswap Trading API is the best on-chain swap API we evaluated. The routing optimization is noticeably better than calling router contracts directly, the permit2 flow reduces approval transactions, and the chain coverage is broad. The main areas for improvement are error specificity on quote failures and clearer documentation on the UniswapX vs CLASSIC execution flow divergence.
