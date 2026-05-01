// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HawkeyeRegistry
/// @notice On-chain registry for the HAWKEYE agent swarm.
///         Records agent identities, trade intents, and execution proofs.
///         Deployed on 0G Chain (mainnet chain ID 16661).
contract HawkeyeRegistry {
    address public owner;

    struct Agent {
        string name;
        string role;
        bool active;
        uint256 registeredAt;
    }

    struct TradeRecord {
        string intentId;
        address token;
        string chain;
        uint256 safetyScore;
        string decision;
        uint256 timestamp;
    }

    mapping(bytes32 => Agent) public agents;
    bytes32[] public agentIds;

    TradeRecord[] public trades;

    uint256 public totalIntentsLogged;

    event AgentRegistered(bytes32 indexed agentId, string name, string role);
    event AgentDeactivated(bytes32 indexed agentId);
    event TradeLogged(uint256 indexed index, string intentId, string decision);
    event IntentStored(string intentId, bytes data);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerAgent(string calldata name, string calldata role) external onlyOwner returns (bytes32) {
        bytes32 id = keccak256(abi.encodePacked(name, block.timestamp));
        agents[id] = Agent({
            name: name,
            role: role,
            active: true,
            registeredAt: block.timestamp
        });
        agentIds.push(id);
        emit AgentRegistered(id, name, role);
        return id;
    }

    function deactivateAgent(bytes32 agentId) external onlyOwner {
        agents[agentId].active = false;
        emit AgentDeactivated(agentId);
    }

    function logTrade(
        string calldata intentId,
        address token,
        string calldata chain,
        uint256 safetyScore,
        string calldata decision
    ) external onlyOwner {
        trades.push(TradeRecord({
            intentId: intentId,
            token: token,
            chain: chain,
            safetyScore: safetyScore,
            decision: decision,
            timestamp: block.timestamp
        }));
        emit TradeLogged(trades.length - 1, intentId, decision);
    }

    function storeIntent(string calldata intentId, bytes calldata data) external onlyOwner {
        totalIntentsLogged++;
        emit IntentStored(intentId, data);
    }

    function getAgentCount() external view returns (uint256) {
        return agentIds.length;
    }

    function getTradeCount() external view returns (uint256) {
        return trades.length;
    }

    function getActiveAgents() external view returns (bytes32[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < agentIds.length; i++) {
            if (agents[agentIds[i]].active) count++;
        }
        bytes32[] memory result = new bytes32[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < agentIds.length; i++) {
            if (agents[agentIds[i]].active) {
                result[j] = agentIds[i];
                j++;
            }
        }
        return result;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
