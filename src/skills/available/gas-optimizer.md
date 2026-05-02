---
name: "Gas Optimizer"
description: "EVM gas estimation, optimization tips, and timing strategies across chains"
enabled: true
priority: 72
tags: ["gas", "optimization", "evm", "cost"]
---

# Gas Optimizer

Optimize transaction costs across all EVM chains. Always consider gas when recommending actions.

## Chain Gas Profiles (typical ranges)

| Chain | Avg Gas (Gwei) | Swap Cost | Notes |
|---|---|---|---|
| Ethereum | 15-80 | $5-$50 | Highest. Use L2 when possible |
| BSC | 3-5 | $0.10-$0.30 | Very cheap, centralized |
| Polygon | 30-100 | $0.01-$0.05 | Cheap but variable |
| Arbitrum | 0.1-0.3 | $0.10-$0.50 | L2, depends on L1 DA cost |
| Base | 0.001-0.01 | $0.01-$0.10 | Cheapest Coinbase L2 |
| Optimism | 0.001-0.01 | $0.01-$0.10 | OP Stack L2 |
| Avalanche | 25-30 | $0.05-$0.20 | Fast finality |
| zkSync Era | 0.25 | $0.10-$0.30 | ZK rollup, account abstraction |
| Scroll | 0.05-0.1 | $0.03-$0.15 | ZK rollup |
| Linea | 0.05-0.1 | $0.03-$0.15 | Consensys ZK rollup |

## Timing Strategies
- **Ethereum mainnet**: Gas is cheapest on weekends (Saturday/Sunday) and early morning UTC (02:00-08:00)
- **L2 chains**: Gas spikes when L1 data posting fees increase (check L1 gas)
- **BSC/Polygon**: Relatively stable, timing matters less

## Optimization Rules
1. **Batch operations**: Approve + swap in one transaction when possible
2. **Token approvals**: Use `approve(MAX_UINT256)` to avoid repeated approvals
3. **Permit2**: Recommend protocols using Permit2 for gasless approvals
4. **Chain routing**: If token exists on multiple chains, recommend cheapest
5. **Failed transaction prevention**: Always estimate gas before sending

## Response Behavior
- When suggesting a trade, always mention the estimated gas cost
- If Ethereum mainnet gas is > 40 Gwei, suggest waiting or using an L2
- For small trades (< $100), warn if gas exceeds 5% of trade value
- Recommend the cheapest chain where the token has sufficient liquidity
- Mention current gas conditions when relevant
