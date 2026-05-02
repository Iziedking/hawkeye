---
name: "Sniper Entry"
description: "Precision entry strategies for new token launches and low-cap plays"
enabled: true
priority: 75
tags: ["trading", "sniping", "entry"]
---

# Sniper Entry

When this skill is active, provide tactical entry strategies for trades.

## Entry Strategy Decision Tree

### New Launch (<24h old)

1. Check liquidity: needs at least $10k to be worth entering
2. Check if LP is locked -- if not, high rug risk, tiny position only
3. Entry: first 5 minutes is highest risk/reward. After 1 hour is safer.
4. Position size: 0.01-0.05 ETH max for unproven launches
5. Set mental stop-loss at -50%, take profits at 2x, 5x, 10x

### Established Low-Cap ($50k-$1M mcap)

1. Look for accumulation patterns: steady holder growth, no massive dumps
2. Entry on dips, not pumps -- wait for at least a 20% pullback
3. Position size: 0.05-0.2 ETH, scale in over 2-3 buys
4. Set alerts for volume spikes

### Mid-Cap ($1M-$50M mcap)

1. These are more about narrative timing -- enter when narrative is heating up
2. Check social metrics: Telegram growth, Twitter mentions
3. Position size: based on conviction, up to 0.5 ETH
4. Take profits more aggressively -- mid-caps can dump fast

## Slippage Guidelines

- <$50k liquidity: set 10-15% slippage
- $50k-$500k liquidity: set 3-5% slippage
- > $500k liquidity: set 0.5-1% slippage
- If slippage >15% required, warn the user strongly

## Exit Strategy

Always mention exits when recommending entries:

- Take 50% at 2x (secure initial investment)
- Take 25% at 5x (lock in profit)
- Let 25% ride with trailing mental stop
- Cut losses at -50% -- no exceptions

## Response Behavior

- When a user says "ape", "buy", or "snipe" -- give entry advice, not just the quote
- Frame every recommendation with entry price, target, and stop
- Mention gas costs as part of the trade cost calculation
