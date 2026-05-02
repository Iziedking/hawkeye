---
name: "MEV Shield"
description: "Protect users from MEV attacks, sandwich attacks, and front-running"
enabled: true
priority: 92
tags: ["mev", "security", "frontrun", "sandwich"]
---

# MEV Shield

Protect users from MEV (Maximal Extractable Value) attacks. This is a security-critical skill.

## Attack Types to Guard Against

### Sandwich Attack (Most Common)
**How it works**: Attacker sees your buy in the mempool, places a buy before yours (front-run), your buy pushes price up, attacker sells after (back-run), you get worse price.
- **Mitigation**: Set tight slippage (0.5-1%), use private RPCs, or MEV-protected DEXs

### Front-Running
**How it works**: Bots see your pending transaction and submit the same trade with higher gas to execute first.
- **Mitigation**: Use Flashbots RPC (Ethereum), private mempools, or low-visibility chains

### Just-In-Time (JIT) Liquidity
**How it works**: MEV bot adds liquidity just before your swap, captures fees, and removes it after.
- **Impact**: Usually minimal to user, but shows bot activity on the token

### Backrunning
**How it works**: Bots detect your large trade and immediately arbitrage the price impact.
- **Impact**: Doesn't directly hurt you, but indicates price instability

## Protection Recommendations

### Per-Chain MEV Protection
| Chain | Protection Method |
|---|---|
| Ethereum | Flashbots Protect RPC, MEV Blocker |
| BSC | BloxRoute, low slippage |
| Arbitrum | Sequencer ordering (partial) |
| Base | Sequencer ordering (partial) |
| Polygon | Flashbots Protect on Polygon |

### Slippage Guidelines
- **Stable pairs** (ETH/USDC): 0.1-0.3% slippage
- **Major tokens** (top 100): 0.5-1% slippage
- **Small caps**: 1-3% slippage
- **Micro caps / memecoins**: 3-15% slippage (higher MEV risk)
- **If slippage > 10% required**: Warn user strongly, likely honeypot or extreme tax

## Response Rules
- Always recommend appropriate slippage based on token liquidity
- For large trades on Ethereum mainnet, ALWAYS suggest Flashbots or private RPC
- If a token requires high slippage, explain why (tax vs MEV vs low liquidity)
- Warn users about the risks of setting slippage too high (MEV bots exploit this)
- For memecoins, suggest splitting into smaller trades to reduce sandwich attack impact
