import { ethers } from "ethers";
import { envOr, requireEnv } from "../../shared/env";

const DEFAULT_RPC_URL = "https://evmrpc-testnet.0g.ai";

export async function checkOgBalance(): Promise<void> {
  try {
    const pk = requireEnv("HAWKEYE_EVM_PRIVATE_KEY");
    const rpcUrl = envOr("OG_RPC_URL", DEFAULT_RPC_URL);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(pk, provider);
    const addr = wallet.address;
    const balance = await provider.getBalance(addr);
    const a0gi = ethers.formatEther(balance);
    const num = parseFloat(a0gi);
    if (num < 1) {
      console.warn(`[0g] wallet ${addr} balance: ${a0gi} A0GI — LOW, transactions may fail`);
    } else {
      console.log(`[0g] wallet ${addr} balance: ${a0gi} A0GI`);
    }
  } catch (err) {
    console.warn("[0g] balance check failed:", (err as Error).message);
  }
}
