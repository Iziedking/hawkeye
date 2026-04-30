# 0G -- Builder Feedback

Project: HAWKEYE (autonomous trading agent swarm)
Integration: 0G Compute (LLM inference), 0G Storage (audit trail), 0G Chain (agent registry + trade proofs).
SDK versions: `@0gfoundation/0g-ts-sdk` v1.2.8, `@0glabs/0g-serving-broker` latest.

## How we used it

Compute: LLM router classifies every user message into 10 intent categories. Conversational replies for general queries. Agent analysis prompts.
Storage: Fire-and-forget writes at 6 lifecycle points (intent, safety, strategy, execution, research, alpha signals).
Chain: HawkeyeRegistry contract stores agent identities and logs every trade execution on-chain.

## What worked

- 0G Compute inference works reliably on Galileo testnet. Sub-2s latency for classification tasks with qwen-2.5-7b-instruct.
- The broker 3-step fund flow (addLedger/depositFund, acknowledgeProviderSigner, transferFund) is well-documented across the starter kit, docs.0g.ai, and type declarations. Clean pattern once you understand it.
- The `[tx, err]` tuple return from `Indexer.upload()` is clearly documented in the README.
- Storage upload flow for `ZgFile` is straightforward with good examples in the starter kit.
- On-chain verifiability of inference is a strong differentiator for trading agents.
- Encryption/decryption support is documented at docs.0g.ai for builders who need it.

## Pain points

- The testnet indexer (`indexer-storage-testnet-turbo.0g.ai`) intermittently rejects requests without clear error documentation. We saw 403 responses with no body and no rate-limit headers. Without documented error codes or rate limit guidance, builders cannot distinguish transient failures from permanent blocks or rate limits. We added a circuit breaker to handle this gracefully.
- `MemData` (our primary pattern for JSON audit trail writes) is documented on the docs.0g.ai site but not in the `@0gfoundation/0g-ts-sdk` package README. Builders who read only the package README would miss this class entirely.

## Documentation gaps

- No documentation on Storage indexer error codes, rate limits, or maintenance windows. When the indexer returns non-200 responses, there is no guidance on retry behavior. The Compute docs document rate limits (30 req/min, 5 concurrent) but Storage has nothing equivalent.
- `processResponse()` in the Compute SDK can throw on testnet (no TEE receipts available), but this is not documented. The docs describe it as optional verification but don't mention failure modes. A note saying "testnet may not support verification receipts" would save debugging time.
- No examples of fire-and-forget or background storage writes. All docs and starter kit examples show sequential await-and-check patterns. For audit trail use cases (common in agent systems), a fire-and-forget pattern with error handling guidance would be valuable.

## Feature requests

- Health check endpoint on the Storage indexer (e.g., `/health`) so agents can probe availability.
- Batch write API for audit trails. We make 6 writes per trade lifecycle. A batch endpoint accepting multiple payloads would reduce costs.
- Documented error codes with recommended retry strategies for the Storage indexer.

## SDK feedback

- The `Indexer` class TypeScript types use `any` in several return positions. Stronger types would catch integration bugs at compile time.
- Consider a `StorageWriter` convenience class that wraps MemData creation, upload, and tuple unpacking. Most audit-trail users just want `write(key, json) -> rootHash`.

## Overall rating (1-10): 7

Compute is solid (8/10). Storage works well when the indexer is healthy, but the lack of error documentation and intermittent testnet issues bring it down (6/10). Documentation is good on docs.0g.ai but the package READMEs could be more complete.

---

Last updated: 2026-04-30
