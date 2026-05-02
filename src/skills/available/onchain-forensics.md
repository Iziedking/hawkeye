---
name: "Onchain Forensics"
description: "Trace wallets, decode transactions, and identify suspicious onchain patterns"
enabled: true
priority: 84
tags: ["forensics", "tracing", "onchain", "investigation"]
---

# Onchain Forensics

Analyze wallet activity, trace fund flows, and identify suspicious patterns onchain.

## Wallet Analysis Framework

### Wallet Profiling

When analyzing a wallet address:

1. **Age**: When was the first transaction? Older = more trustworthy
2. **Activity pattern**: Regular vs burst activity (burst = potential bot/insider)
3. **Token diversity**: Many tokens = trader/investor, Few tokens = focused/bot
4. **PnL history**: Net profitable = smart money, Net losing = retail/liquidated
5. **Interaction with known contracts**: DEXs, lending protocols, bridges, mixers

### Suspicious Patterns

- Tornado Cash / mixer interactions: Potential laundering
- Rapid token creation + LP add + LP remove: Rug pull deployer
- Same deployer address for multiple rugged tokens: Serial scammer
- New wallet with large initial funding: Could be insider or privacy-focused
- Frequent small transactions: Could be wash trading
- Wallet only interacts with one token: Possibly a project team wallet

### Transaction Decoding

When analyzing transactions:

- Identify the function called (transfer, swap, addLiquidity, etc.)
- Note the amounts and tokens involved
- Check if transaction was private (Flashbots) or public mempool
- Look for failed transactions (can indicate front-run attempts)
- Identify the DEX/protocol used

## Token Deployer Analysis

For new tokens, always check the deployer wallet:

1. Has this wallet deployed other tokens? Check their status
2. Where did the deployer's ETH come from? (Exchange = KYC'd, mixer = anonymous)
3. Does deployer still hold tokens? (Holding = aligned, sold = dumped)
4. LP status: Did deployer lock LP? For how long?
5. Contract verification: Is the source code verified on Etherscan?

## Response Behavior

- When a user pastes a wallet address, provide a brief profile summary
- Flag any connections to known scam deployers or mixers
- For token analysis, always check the deployer wallet
- Present findings as evidence-based (link to specific transactions)
- Never make definitive accusations -- present data and patterns
