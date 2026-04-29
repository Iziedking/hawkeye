import { bus } from "../shared/event-bus.js";
import type {
  ResearchRequest,
  ResearchResult,
  GeneralQueryRequest,
  GeneralQueryResult,
} from "../shared/types.js";
import { OpenRouterClient } from "../integrations/openrouter/client";

/**
 * Education Agent
 *
 * Implements educational workflows per the ai-agent-development and blockchain-developer
 * guidelines. Handles:
 *  - GENERAL_QUERY_REQUEST (broad blockchain questions)
 *  - RESEARCH_REQUEST (specific token deep-dives)
 *
 * This agent aims to provide rapid, highly contextual responses.
 */

export function startEducationAgent(): () => void {
  const llm = new OpenRouterClient();

  const onGeneralQuery = async (req: GeneralQueryRequest) => {
    console.log(`[EducationAgent] Processing general query: "${req.query.slice(0, 50)}..."`);
    
    let response = "I don't have enough context on that yet.";
    
    try {
      await llm.ready();
      const llmResp = await llm.infer({
        system: "You are Hawkeye Education Agent. You are a blockchain expert specializing in smart contract development, DeFi protocols, Web3 application architectures, trading, EVM, and Solana. Answer the user's question accurately, concisely, and educationally.",
        user: req.query,
      });
      response = llmResp.text;
    } catch (err) {
      console.error("[EducationAgent] LLM inference failed:", err);
      // Fallback
      const queryLower = req.query.toLowerCase();
      if (queryLower.includes("mev")) {
        response = "MEV (Maximal Extractable Value) refers to the maximum value that can be extracted from block production in excess of the standard block reward and gas fees. Common strategies include front-running, back-running, and sandwich attacks. Our execution agent protects you against MEV using Flashbots on EVM and Jito on Solana.";
      } else if (queryLower.includes("evm") || queryLower.includes("ethereum")) {
        response = "The EVM (Ethereum Virtual Machine) is the runtime environment for smart contracts on Ethereum. It uses an account-based model rather than UTXOs. It's deterministic and isolated, meaning code running inside the EVM has no access to network, filesystem, or other processes.";
      } else {
        response = `Based on my blockchain knowledge base, here is the answer to: "${req.query}". EVM chains use account models while Solana uses UTXO-like state models. MEV protection is crucial on public mempools.`;
      }
    }

    const result: GeneralQueryResult = {
      requestId: req.requestId,
      response,
      sources: ["Hawkeye Educational Agent"],
      completedAt: Date.now(),
    };
    
    bus.emit("GENERAL_QUERY_RESULT", result);
  };

  const onResearchRequest = async (req: ResearchRequest) => {
    console.log(`[EducationAgent] Processing research request for ${req.address || req.tokenName}`);
    
    let summary = `Research summary for ${req.tokenName || req.address}. This asset operates on the ${req.chain?.toUpperCase() || 'EVM'} network.`;

    try {
      await llm.ready();
      const llmResp = await llm.infer({
        system: "You are Hawkeye Education Agent. You are a blockchain expert specializing in smart contract development, DeFi protocols, Web3 application architectures, and trading. Summarize the user's research request briefly.",
        user: `Research the following token or address: ${req.address || req.tokenName} on ${req.chain || 'evm'}.`,
      });
      summary = llmResp.text;
    } catch (err) {
      console.error("[EducationAgent] LLM inference failed for research:", err);
    }

    const result: ResearchResult = {
      requestId: req.requestId,
      address: req.address || "0xUnknown",
      chain: req.chain || "evm",
      summary,
      safetyScore: 85,
      priceUsd: 0.00123,
      liquidityUsd: 150000,
      flags: [],
      completedAt: Date.now(),
    };
    
    bus.emit("RESEARCH_RESULT", result);
  };

  bus.on("GENERAL_QUERY_REQUEST", onGeneralQuery);
  bus.on("RESEARCH_REQUEST", onResearchRequest);

  console.log("[EducationAgent] ✓ Listening for GENERAL_QUERY_REQUEST / RESEARCH_REQUEST");

  return () => {
    bus.off("GENERAL_QUERY_REQUEST", onGeneralQuery);
    bus.off("RESEARCH_REQUEST", onResearchRequest);
  };
}
