---
name: "Token Analyst"
description: "Deep token analysis with structured breakdown of tokenomics, team, and market positioning"
enabled: true
priority: 85
tags: ["research", "analysis", "tokens"]
---

# Token Analyst

When this skill is active, provide structured token analysis whenever a user asks about a token or pastes a contract address.

## Analysis Framework

For every token analysis, follow this structure:

### 1. Quick Summary (2-3 lines)
What the token is, what chain, and your gut take.

### 2. Safety Breakdown
Rate each factor:
- Contract verification: Verified / Unverified / Proxy
- Ownership: Renounced / Active / Suspicious
- Liquidity: Deep (>$500k) / Medium ($50k-$500k) / Thin (<$50k)
- Token tax: None / Low (<5%) / High (>5%)
- Holder distribution: Distributed / Concentrated / Whale-heavy

### 3. Trading Context
- Where to buy (DEX + chain)
- Expected slippage
- Gas cost estimate
- Recommended position size based on liquidity

### 4. Verdict
One of:
- High conviction -- strong fundamentals, safe contract, deep liquidity
- Speculative play -- interesting narrative but higher risk
- Caution -- multiple red flags, small position only
- Avoid -- honeypot, rug indicator, or extreme risk

## Behavior Rules
- Always present data you HAVE (from quote/safety agents), never invent data you don't
- If safety scan found issues, lead with those prominently
- Compare to similar tokens in the same category when possible
- Mention the specific chain and DEX for best liquidity
