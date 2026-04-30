// Deploy HawkeyeRegistry to 0G Chain mainnet.
// Usage: npx tsx scripts/deploy-registry.ts
//
// Requires:
//   HAWKEYE_EVM_PRIVATE_KEY in .env.local (funded with 0G tokens on mainnet)
//
// After deployment, registers all 7 HAWKEYE agents on-chain.

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { loadEnvLocal, requireEnv } from "../src/shared/env";

loadEnvLocal();

const OG_MAINNET_RPC = "https://evmrpc.0g.ai";
const OG_MAINNET_CHAIN_ID = 16661;

const AGENTS = [
  { name: "Safety Agent", role: "Token security scanner (GoPlus, Honeypot.is, RugCheck)" },
  { name: "Quote Agent", role: "Price resolution and slippage estimation (DexScreener, Uniswap)" },
  { name: "Strategy Agent", role: "Risk scoring and trade decision engine" },
  { name: "Execution Agent", role: "On-chain swap execution (Uniswap, Jupiter, KeeperHub)" },
  { name: "Research Agent", role: "Alpha discovery and token analysis" },
  { name: "Monitor Agent", role: "Position tracking and exit trigger evaluation" },
  { name: "Copy Trade Agent", role: "Wallet watching and trade replication" },
];

async function main(): Promise<void> {
  const pk = requireEnv("HAWKEYE_EVM_PRIVATE_KEY");

  console.log("[deploy] connecting to 0G mainnet...");
  const provider = new ethers.JsonRpcProvider(OG_MAINNET_RPC, OG_MAINNET_CHAIN_ID);
  const wallet = new ethers.Wallet(pk, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`[deploy] wallet: ${wallet.address}`);
  console.log(`[deploy] balance: ${ethers.formatEther(balance)} 0G`);

  if (balance === 0n) {
    console.error("[deploy] wallet has no 0G tokens. Fund it first.");
    process.exit(1);
  }

  // Compile with solc
  console.log("[deploy] compiling HawkeyeRegistry.sol...");
  const solPath = resolve(__dirname, "../contracts/HawkeyeRegistry.sol");

  let solcOutput: string;
  try {
    solcOutput = execSync(
      `npx solcjs --optimize --bin --abi ${solPath} --base-path ${resolve(__dirname, "../contracts")}`,
      { encoding: "utf8", cwd: resolve(__dirname, "..") },
    );
    console.log("[deploy] compilation done");
  } catch (err) {
    console.error("[deploy] solc compilation failed. Installing solc...");
    execSync("npm install -g solc@0.8.28", { stdio: "inherit" });
    solcOutput = execSync(
      `npx solcjs --optimize --bin --abi ${solPath} --base-path ${resolve(__dirname, "../contracts")}`,
      { encoding: "utf8", cwd: resolve(__dirname, "..") },
    );
  }

  // Find compiled artifacts
  const cwd = resolve(__dirname, "..");
  const binFile = execSync(`find ${cwd} -name "*HawkeyeRegistry.bin" -newer ${solPath} | head -1`, {
    encoding: "utf8",
  }).trim();
  const abiFile = execSync(`find ${cwd} -name "*HawkeyeRegistry.abi" -newer ${solPath} | head -1`, {
    encoding: "utf8",
  }).trim();

  if (!binFile || !abiFile) {
    console.error("[deploy] compiled artifacts not found. Check solc output.");
    process.exit(1);
  }

  const bytecode = "0x" + readFileSync(binFile, "utf8").trim();
  const abi = JSON.parse(readFileSync(abiFile, "utf8"));

  console.log(`[deploy] bytecode: ${bytecode.length} chars`);
  console.log(`[deploy] abi: ${abi.length} entries`);

  // Deploy
  console.log("[deploy] deploying HawkeyeRegistry...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction()!.wait();

  const contractAddress = await contract.getAddress();
  console.log(`[deploy] deployed at: ${contractAddress}`);
  console.log(`[deploy] tx hash: ${receipt!.hash}`);
  console.log(`[deploy] explorer: https://chainscan.0g.ai/address/${contractAddress}`);

  // Register all agents
  console.log("[deploy] registering agents...");
  const registry = new ethers.Contract(contractAddress, abi, wallet);

  for (const agent of AGENTS) {
    const tx = await registry.registerAgent(agent.name, agent.role);
    await tx.wait();
    console.log(`[deploy] registered: ${agent.name}`);
  }

  const count = await registry.getAgentCount();
  console.log(`[deploy] ${count} agents registered on-chain`);

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`Contract: ${contractAddress}`);
  console.log(`Explorer: https://chainscan.0g.ai/address/${contractAddress}`);
  console.log(`Chain: 0G Mainnet (${OG_MAINNET_CHAIN_ID})`);
  console.log("\nAdd this to README.md and submission form.");
}

main().catch((err) => {
  console.error("[deploy] fatal:", err);
  process.exit(1);
});
