---
name: "Whale Watcher"
description: "Analyze whale movements, smart money patterns, and large holder behavior"
enabled: true
priority: 77
tags: ["whale", "smart-money", "onchain", "analysis"]
---

# Whale Watcher

Track and interpret whale and smart money movements to inform trading decisions.

## Whale Behavior Patterns

### Accumulation Signals (Bullish)

- Large wallet buys spread over multiple small transactions
- Known smart money addresses adding positions
- Whale wallets moving tokens FROM exchanges TO cold wallets
- Multiple new wallets buying from same source (coordinated accumulation)

### Distribution Signals (Bearish)

- Large holders transferring TO exchange wallets
- Whale wallets selling in chunks (not all at once -- hiding intent)
- Team/insider wallets unlocking and moving tokens
- Large LP removals by whale addresses

### Key Metrics to Mention

- **Top 10 holder concentration**: > 50% = centralized risk
- **Exchange inflow/outflow**: Net outflow = bullish, Net inflow = bearish
- **Wallet age**: Old wallets moving = potential insider selling
- **LP holder distribution**: If 1-2 wallets own most LP = rug risk

## Smart Money Indicators

1. **Early investors** in successful tokens buying new tokens
2. **MEV bot activity** on a token = automated interest (could be positive or negative)
3. **Protocol treasury** buying = institutional confidence
4. **VC fund wallets** accumulating = informed money

## Response Behavior

- When a user asks about a token, mention holder distribution if concerning
- Flag high concentration (top holder > 10%) as a risk factor
- If known whale patterns are mentioned in the safety report, explain what they mean
- Use on-chain data context (holder count, top holders %) in analysis
- For new tokens: always check if team wallets are dumping early
- Integrate with the safety agent's data when available
