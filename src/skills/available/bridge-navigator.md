---
name: "Bridge Navigator"
description: "Cross-chain bridge routing, cost comparison, and safety guidance"
enabled: true
priority: 68
tags: ["bridge", "cross-chain", "multichain"]
---

# Bridge Navigator

Guide users on moving assets between EVM chains safely and cheaply.

## Trusted Bridge Protocols

### Canonical Bridges (Safest -- native to the chain)
- **Arbitrum Bridge**: Ethereum <> Arbitrum, 7 day withdrawal to L1
- **Base Bridge**: Ethereum <> Base, 7 day withdrawal to L1
- **Optimism Bridge**: Ethereum <> Optimism, 7 day withdrawal to L1
- **Polygon Bridge**: Ethereum <> Polygon PoS, variable withdrawal
- **zkSync Bridge**: Ethereum <> zkSync Era, ~24hr withdrawal

### Third-Party Bridges (Faster, more chains)
- **Stargate (LayerZero)**: Multi-chain, good liquidity, ~2-10 min
- **Across Protocol**: Fast finality, competitive fees, optimistic verification
- **Hop Protocol**: Ethereum + L2s, Bonder-based fast transfers
- **Synapse**: Multi-chain including non-EVM, ~5-15 min
- **Circle CCTP**: USDC native bridging (mint/burn), cheapest for USDC

### Aggregators (Compare routes)
- **Li.Fi**: Aggregates bridges + DEXs for optimal routing
- **Socket**: Multi-bridge aggregator, best-price routing
- **Bungee**: Built on Socket, user-friendly

## Decision Matrix

| Scenario | Recommendation |
|----------|---|
| Moving ETH to Arbitrum | Canonical bridge (cheapest) |
| Need funds in < 10 min | Across or Stargate |
| Moving USDC between chains | Circle CCTP (native, no wrapping) |
| Moving tokens to BSC | Stargate or Synapse |
| Large amounts (> $50k) | Canonical bridge (safest) |
| Small amounts (< $100) | Check if gas cost is worth it |

## Safety Rules
- NEVER recommend unknown or unaudited bridges
- Always check bridge TVL and recent transaction volume
- Warn about wrapped token risks (WETH vs ETH, bridged USDC vs native)
- For amounts > $10k, recommend splitting across multiple transactions
- Mention withdrawal delays for canonical bridges (7 days for optimistic rollups)
- If a user is bridging to buy a specific token, check if the token exists on a cheaper chain first

## Response Behavior
- When a user mentions buying a token on an expensive chain, suggest cheaper alternatives
- Include estimated bridge cost and time in recommendations
- Warn about liquidity on the destination chain before bridging
- Always prefer native assets over wrapped/bridged versions
