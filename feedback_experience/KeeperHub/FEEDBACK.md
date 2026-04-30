# KeeperHub -- Builder Feedback

Project: HAWKEYE (autonomous trading agent swarm)
Integration: Execution Agent routes all EVM transactions through KeeperHub for gas estimation, tx simulation, and MEV-protected bundle submission.

## How we used it

- MCP server at `app.keeperhub.com/mcp` for workflow management, action schemas, and execution monitoring.
- REST API endpoints: `/v1/gas`, `/v1/simulate`, `/v1/bundle` for real-time tx execution.
- All EVM swaps (Uniswap Trading API output) routed through KeeperHub for private execution, preventing sandwich attacks on user trades.

## What worked

- (pending live testing)

## Pain points

- MCP OAuth flow on Claude Code (Windows, HTTP transport) consistently fails to load tools after successful browser authorization. The OAuth callback server processes the auth code before Claude Code can exchange it, leaving the MCP in a permanent "needs authentication" state. Tried 5+ attempts across 2 separate sessions. The browser always shows "Authentication Successful" but the tools never appear.
- Two auth methods documented (OAuth 2.1 and API key via Bearer header) but unclear which token format maps to which method. The API key docs show `kh_` prefix but the dashboard issued a `wfb_` prefixed token. Setting the Bearer header in the HTTP transport config did not bypass OAuth.
- No fallback when MCP auth fails. Would be useful to have a CLI tool or curl-based verification step to confirm the token is valid independently of the MCP protocol.

## Bugs encountered

- OAuth race condition: `complete_authentication` always returns "No OAuth flow is in progress" because the local callback server at `localhost:<port>/callback` processes the code exchange before the MCP client can invoke `complete_authentication`. This is reproducible on every attempt.
- After removing the Bearer header and doing a clean OAuth-only flow, same result. The MCP transport appears to exchange the code successfully (browser confirms) but never refreshes the tool registry.

## Documentation gaps

- The relationship between `wfb_` tokens (workflow bot?) and `kh_` tokens (API key) is not documented. Which token type works for MCP auth vs REST API auth?
- No troubleshooting guide for MCP auth failures. When OAuth completes in the browser but tools don't load, there's no way to diagnose what went wrong.
- Missing: example `.mcp.json` configurations for different environments (Claude Code, Cursor, etc.) showing the exact JSON structure needed.

## Feature requests

- API key auth that bypasses OAuth entirely for headless/CI environments. A simple Bearer token in the HTTP headers should be sufficient to access MCP tools without the browser flow.
- Health check endpoint (`GET /health` or similar) that returns auth status and available tools, so builders can verify their setup independently.
- Webhook support for tx status updates instead of polling. When a bundle is submitted, push the confirmation back to the agent rather than requiring periodic checks.

## SDK feedback

- No TypeScript SDK available. We're making raw HTTP calls to the REST API. A typed client (`@keeperhub/sdk`) with methods like `estimateGas()`, `simulateTx()`, `submitBundle()` would save significant integration time.

## Overall rating (1-10): (pending -- blocked on auth, cannot test functional integration)

---
Last updated: 2026-04-30
