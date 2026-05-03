# Builder feedback — KeeperHub

Submitted for the KeeperHub Builder Feedback Bounty at the OpenAgents
hackathon. Honest, actionable, specific.

## How HAWKEYE uses KeeperHub

Every EVM mainnet swap our Execution agent submits is routed through
KeeperHub for MEV protection, with a circuit breaker that lets the trade
fall through to the wallet manager if KeeperHub is unreachable.

- `src/integrations/keeperhub/index.ts` — main client, circuit breaker,
  network resolution.
- `src/integrations/keeperhub/dual-wallet.ts` — agent-vs-external wallet
  selection for the user profile.
- `src/integrations/keeperhub/wallet.ts` — KeeperHub Turnkey wallet
  provider integration.
- Pre-wired into `.mcp.json` as a remote MCP server.

## What worked

- **The circuit-breaker contract is exactly right for production**. We open
  the breaker on transient failures (timeout, 5xx) and let user trades
  proceed without KeeperHub rather than hard-fail. The boot probe
  (`checkReachable()`) telegraphs to operators whether MEV protection will
  actually be active.
- **`networkFromChainId(chainId)` is a clean affordance** — no need to
  maintain our own chain → network-name map.
- **MCP server worked first try** when we wired it into `.mcp.json`.
  Compared to other partners' MCP integrations we tried, KeeperHub's was
  the lowest-friction onboarding.

## UX / DX friction

### 1. `KH_WALLET_ADDRESS not set, KeeperHub Turnkey wallet provider disabled`

This warning fires at boot whether or not the user has configured a Turnkey
wallet. It's correctly informational, but the wording suggests something
broken. Suggested rewording:

```
KeeperHub Turnkey wallet support is OFF (KH_WALLET_ADDRESS unset).
MEV-protected submission still works for any wallet you provide.
```

This makes it clear that the _core_ MEV protection still works — only the
Turnkey-specific wallet feature is gated on this env var.

### 2. Documentation for the dual-wallet pattern is sparse

KeeperHub supports both "agent-controlled" wallets and "external" wallets
(user-signed via WalletConnect, etc.). We had to read the SDK source to
understand which functions need `agentWallet` vs `external`. A page titled
"When to use which wallet provider" with concrete code examples for each
flow would have saved 2-3 hours.

### 3. `getExecutionStatus()` shape is identical for success and "not yet started"

We log every swap submission via `getExecutionStatus("hawkeye-<action>-<txHashPrefix>")`
and have to inspect timestamps to know whether the keeper actually picked it
up. A `state: "queued" | "in_flight" | "submitted" | "confirmed"` field on the
response would let agents render real-time progress without guessing.

### 4. No webhook / event stream for execution lifecycle

We currently fire-and-forget the KeeperHub log call (`logToKeeperHub` in
`src/agents/execution/index.ts:159`) because there's no reliable callback.
A webhook on submitted/confirmed would let us update Telegram replies and
0G audit-trail entries the moment KeeperHub confirms inclusion.

## Bugs

- We hit one occurrence where `getExecutionStatus` returned a 404 on an
  executionId that existed in another query 30 seconds later. Possibly a
  read-replica lag. Not reproducible deterministically.
- The circuit breaker doesn't have an obvious "force-close" / reset path.
  Once `circuitOpen` flips true, it stays open until process restart in our
  code. We mitigated locally but a documented `client.resetCircuit()` would
  make `KeeperHubClient` self-healing across long-running agent processes.

## Documentation gaps

- The MCP server's tool list isn't documented anywhere we could find. We
  enumerated it by spawning the MCP and listing tools. A page in the docs
  with `{ name, description, inputs }` for each MCP tool would let agent
  framework authors wire it up without round-tripping the server.
- `circuitOpen`, `checkReachable()`, `networkFromChainId()` are referenced
  in our integration but not in the public docs we found. They're exported
  by the SDK; would be great to have them in the API reference.
- No clear answer to "what's the maximum gas price the keeper will pay
  before refusing the trade?" — we'd love to surface that to the user as a
  ceiling estimate.

## Feature requests

1. **Lifecycle webhooks** (above) — the single biggest unlock.
2. **Builder-set ceiling gas price** per submission. Right now we trust the
   keeper. For agents managing other people's funds, an explicit
   `maxGasPrice: number` parameter would let us preserve user intent.
3. **Receipt of the actual landing block** in the response, not just the
   tx hash. We can derive it via the explorer but it's a round-trip.
4. **A dry-run mode** — `simulateSubmit({ tx, chainId })` that returns
   "would this be picked up? at what cost?" without committing. Useful for
   agents that want to compare KeeperHub against fall-through cost before
   committing.
5. **Per-network status endpoint** — a single GET that returns
   `{ ethereum: "healthy", bsc: "degraded", arbitrum: "healthy" }`. Today
   we run `checkReachable()` once at boot and assume the answer holds; a
   cheap status endpoint would let agents adapt mid-session.

## What I'd build next on KeeperHub

If we had two more weeks:

- A **per-user keeper preference** stored in our Privy profile. Right now
  every mainnet swap goes through KeeperHub by default; some power users
  might want to bypass on specific chains. The plumbing is trivial; the
  product question is interesting.
- **Cross-keeper redundancy.** Submit the same intent to KeeperHub and a
  fallback (Flashbots / MEV Blocker) and accept whichever lands first.
  KeeperHub's circuit breaker makes this almost free to implement.
- **Agent-paid keeper fees via x402 / MPP.** Would close the loop for
  agent-to-keeper economic relationships without the user manually
  funding the agent wallet.

Repo: https://github.com/Iziedking/hawkeye
Integration paths: `src/integrations/keeperhub/`,
`src/agents/execution/index.ts:159` (the call site).
