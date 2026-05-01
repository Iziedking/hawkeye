import { ethers } from "ethers";
import { envOr, requireEnv } from "../../shared/env";
import { log } from "../../shared/logger";

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
      log.warn(`0G wallet ${addr.slice(0, 12)}... balance: ${a0gi} A0GI — LOW`);
    } else {
      log.og("chain", `wallet ${addr.slice(0, 12)}... balance: ${a0gi} A0GI`);
    }
  } catch (err) {
    log.warn(`0G balance check failed: ${(err as Error).message}`);
  }
}
