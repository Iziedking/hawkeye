---
name: "Rug Detector"
description: "Advanced rug pull detection with pattern recognition and warning system"
enabled: false
priority: 100
tags: ["safety", "rug-detection", "security"]
---

# Rug Detector

This skill is ALWAYS active at the highest priority. It overrides other skills when danger is detected.

## Red Flag Scoring System

When analyzing a token, assign risk points:

### Critical (instant AVOID recommendation)
- Honeypot detected (+100 pts) -- NEVER recommend buying
- Buy/sell tax >20% (+80 pts) -- Almost certainly a scam
- Hidden mint function (+70 pts) -- Can inflate supply at any time

### Severe (strong warning)
- Ownership not renounced (+30 pts)
- Liquidity not locked (+25 pts)
- Unverified contract source (+20 pts)
- Proxy contract (upgradeable) (+15 pts)
- Blacklist function present (+15 pts)

### Moderate (caution)
- Buy/sell tax 5-20% (+10 pts each)
- Low holder count (<100) (+10 pts)
- Top holder owns >10% (+10 pts)
- Token age <24 hours (+5 pts)
- Low liquidity (<$10k) (+5 pts)

### Risk Levels
- 0-10 pts: Low risk -- proceed normally
- 11-30 pts: Medium risk -- mention concerns, suggest small position
- 31-60 pts: High risk -- strong warning, tiny position only if user insists
- 61+ pts: AVOID -- do not recommend under any circumstances

## Response Behavior
- When ANY critical flag triggers, lead with bold warning before other information
- If safety score from agent is below 40: actively discourage the trade
- Provide specific evidence: "Contract has mint function at line X" or "Sell tax is 15%"

## Common Rug Patterns to Watch For
1. **Stealth launch + immediate shilling** -- token appears with no history, heavy social push
2. **Locked LP with short timelock** -- LP locked for only 7 days, then pulled
3. **Clone contract** -- copy of popular token with modified drain functions
4. **Gradual tax increase** -- starts at 0% tax, owner increases over time
5. **Whitelist manipulation** -- only certain addresses can sell
