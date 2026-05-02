import { ethers } from "ethers";
import { envOr } from "../../shared/env";

const REGISTRY_ABI = [
  "function logTrade(string intentId, address token, string chain, uint256 safetyScore, string decision) external",
  "function storeIntent(string intentId, bytes data) external",
  "function getAgentCount() external view returns (uint256)",
  "function getTradeCount() external view returns (uint256)",
  "function getActiveAgents() external view returns (bytes32[])",
];

export type RegistryClientOptions = {
  contractAddress?: string;
  privateKey?: string;
  rpcUrl?: string;
};

export class RegistryClient {
  private readonly contract: ethers.Contract;
  readonly address: string;

  constructor(opts: RegistryClientOptions = {}) {
    this.address = opts.contractAddress ?? envOr("HAWKEYE_REGISTRY_ADDRESS", "");
    if (!this.address) throw new Error("HAWKEYE_REGISTRY_ADDRESS required");

    const pk = opts.privateKey ?? envOr("HAWKEYE_EVM_PRIVATE_KEY", "");
    if (!pk) throw new Error("HAWKEYE_EVM_PRIVATE_KEY required");

    const rpcUrl = opts.rpcUrl ?? envOr("OG_MAINNET_RPC", "https://evmrpc.0g.ai");
    const chainId = Number(envOr("OG_CHAIN_ID", "16661"));

    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    const wallet = new ethers.Wallet(pk, provider);
    this.contract = new ethers.Contract(this.address, REGISTRY_ABI, wallet);
  }

  async logTrade(
    intentId: string,
    tokenAddress: string,
    chain: string,
    safetyScore: number,
    decision: string,
  ): Promise<string> {
    const addr = ethers.isAddress(tokenAddress) ? tokenAddress : ethers.ZeroAddress;
    const fn = this.contract.getFunction("logTrade");
    const tx = await fn(intentId, addr, chain, BigInt(Math.round(safetyScore)), decision);
    const receipt = await tx.wait();
    return receipt.hash as string;
  }

  async storeIntent(intentId: string, data: unknown): Promise<string> {
    const encoded = ethers.toUtf8Bytes(JSON.stringify(data));
    const fn = this.contract.getFunction("storeIntent");
    const tx = await fn(intentId, encoded);
    const receipt = await tx.wait();
    return receipt.hash as string;
  }

  async getTradeCount(): Promise<number> {
    const fn = this.contract.getFunction("getTradeCount");
    const count = await fn();
    return Number(count);
  }

  async getAgentCount(): Promise<number> {
    const fn = this.contract.getFunction("getAgentCount");
    const count = await fn();
    return Number(count);
  }
}
