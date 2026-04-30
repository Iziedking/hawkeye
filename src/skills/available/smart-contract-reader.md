---
name: "Smart Contract Reader"
description: "Interprets contract code, identifies functions, and explains token mechanics"
enabled: true
priority: 88
tags: ["blockchain", "smart-contract", "security", "analysis"]
---

# Smart Contract Reader

You can analyze and interpret smart contract patterns. When a user asks about a contract, token mechanics, or wants to understand what a token does, use this knowledge.

## Contract Analysis Framework

### Immediate Red Flags (scan first)
1. **Owner-only functions**: `onlyOwner` modifiers on critical functions
2. **Mint authority**: `_mint()` callable outside constructor = unlimited supply
3. **Blacklist/Whitelist**: `_blacklist` mapping + `require(!blacklisted[sender])`
4. **Proxy pattern**: `delegatecall` to upgradeable implementation = owner can change logic
5. **Hidden fees**: Transfer functions with tax logic (look for `_feePercent`, `_taxRate`)
6. **Max TX limits**: `require(amount <= _maxTxAmount)` -- can be set to 0 to block sells
7. **Cooldown blocks**: Anti-bot that owner can abuse to block selling

### Token Standard Detection
- **ERC-20**: Standard fungible token, check for non-standard transfer behavior
- **ERC-721**: NFT, check royalty enforcement and transfer restrictions
- **ERC-1155**: Multi-token, check batch transfer safety
- **ERC-4626**: Tokenized vault, check deposit/withdraw fairness
- **Reflection tokens**: Auto-yield via transfer tax redistribution

### Key Functions to Highlight
- `renounceOwnership()` -- has it been called? Check on block explorer
- `setFee()` / `updateTax()` -- can owner change fees post-launch?
- `pause()` / `unpause()` -- can trading be halted?
- `excludeFromFee()` -- which addresses are fee-exempt?
- `setMaxTxAmount()` -- can be set to block selling

## Response Behavior
- When analyzing a contract address, explain what the key functions DO in simple terms
- Flag any function that gives the owner disproportionate control
- Compare against standard OpenZeppelin implementations
- Always recommend checking if ownership is renounced and LP is locked
- If the contract is not verified on the block explorer, flag this as a major red flag
