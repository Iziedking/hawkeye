import type {
  WalletManager,
  PrivyWallet,
  SignTxInput,
  SendTxResult,
  WalletMode,
  UserWalletConfig,
  FullWalletConfig,
} from "../privy/index";
import type { ActiveWalletRef } from "../../shared/types";
import { envOr, loadEnvLocal } from "../../shared/env";
import { JsonStore } from "../../shared/store";
import type { StoredUser, StoredExternalWallet } from "../../shared/store";
import { KeeperHubClient } from "./index";
import type { ExecutionStatus } from "./index";
import {
  getFunctionSelector,
  decodeApprove,
  decodeUniversalRouterExecute,
  UNIVERSAL_ROUTER_EXECUTE_ABI,
  ERC20_APPROVE_ABI,
} from "./abi-decode";

loadEnvLocal();

const CHAIN_NUMERIC_TO_NAME: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  137: "polygon",
  42161: "arbitrum",
  8453: "base",
  10: "optimism",
  43114: "avalanche",
  250: "fantom",
  25: "cronos",
  324: "zksync",
  59144: "linea",
  81457: "blast",
  534352: "scroll",
  5000: "mantle",
  42220: "celo",
  11155111: "sepolia",
  84532: "base-sepolia",
};

function toDecimalWei(value: number | string | undefined): string | undefined {
  if (value === undefined || value === 0 || value === "0") return undefined;
  if (typeof value === "number") return String(Math.floor(value));
  if (value.startsWith("0x") || value.startsWith("0X")) return BigInt(value).toString();
  return value;
}

function weiToHumanReadable(wei: string): string {
  const n = BigInt(wei);
  const whole = n / 1_000_000_000_000_000_000n;
  const frac = n % 1_000_000_000_000_000_000n;
  const fracStr = frac.toString().padStart(18, "0");
  return `${whole}.${fracStr}`.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export function createKeeperHubWalletManager(
  opts: {
    keeperHub?: KeeperHubClient;
    walletAddress?: string;
  } = {},
): WalletManager {
  const khAddress = opts.walletAddress ?? envOr("KH_WALLET_ADDRESS", "");
  if (!khAddress) {
    throw new Error(
      "KH_WALLET_ADDRESS required. Get it from your KeeperHub dashboard and set it in .env.local",
    );
  }

  const kh = opts.keeperHub ?? new KeeperHubClient();
  const store = new JsonStore();

  const khWallet: PrivyWallet = {
    walletId: "keeperhub-turnkey",
    address: khAddress,
    chainType: "ethereum",
    createdAt: Date.now(),
  };

  const walletCache = new Map<string, PrivyWallet>();

  for (const [email, user] of Object.entries(store.allUsers())) {
    if (user.agentWallet) {
      walletCache.set(email, user.agentWallet);
    }
  }
  const restored = walletCache.size;
  if (restored > 0)
    console.log(`[keeperhub-wallet] restored ${restored} user profile(s) from disk`);

  function resolveEmail(userId: string): string | undefined {
    if (userId.includes("@")) return userId;
    return store.resolveProfile("telegram", userId);
  }

  function getProfile(userId: string): StoredUser | undefined {
    const email = resolveEmail(userId);
    if (!email) return undefined;
    return store.getUser(email);
  }

  async function getOrCreateWallet(userId: string): Promise<PrivyWallet> {
    let email = resolveEmail(userId);
    const profile = email ? store.getUser(email) : undefined;

    if (profile?.agentWallet) {
      return profile.agentWallet;
    }

    if (!email) {
      email = `${userId}@hawkeye.local`;
    }

    const newProfile: StoredUser = profile ?? {
      v: 2,
      email,
      privyUserId: null,
      platformIds: [{ platform: "telegram", id: userId }],
      agentWallet: khWallet,
      solanaWallet: null,
      externalWallets: [],
      activeWallet: { kind: "agent" },
      createdAt: Date.now(),
    };

    if (!newProfile.agentWallet) {
      newProfile.agentWallet = khWallet;
    }

    store.setUser(email, newProfile);
    store.linkPlatform("telegram", userId, email);
    store.indexWallet(khWallet.address, email);
    walletCache.set(email, khWallet);

    console.log("[keeperhub-wallet] provisioned wallet for", userId, "→", khAddress);
    return khWallet;
  }

  async function createWalletWithEmail(userId: string, email: string): Promise<PrivyWallet> {
    const existing = resolveEmail(userId);
    if (existing) {
      const profile = store.getUser(existing);
      if (profile?.agentWallet) return profile.agentWallet;
    }

    const newProfile: StoredUser = {
      v: 2,
      email,
      privyUserId: null,
      platformIds: [{ platform: "telegram", id: userId }],
      agentWallet: khWallet,
      solanaWallet: null,
      externalWallets: [],
      activeWallet: { kind: "agent" },
      createdAt: Date.now(),
    };

    if (existing && existing !== email) {
      const oldProfile = store.getUser(existing);
      if (oldProfile) {
        newProfile.externalWallets = oldProfile.externalWallets;
        newProfile.platformIds = oldProfile.platformIds;
        store.deleteUser(existing);
      }
      walletCache.delete(existing);
    }

    store.setUser(email, newProfile);
    store.linkPlatform("telegram", userId, email);
    store.indexWallet(khWallet.address, email);
    walletCache.set(email, khWallet);

    console.log("[keeperhub-wallet] created profile for", email, "→", khAddress);
    return khWallet;
  }

  async function linkEmail(userId: string, email: string): Promise<boolean> {
    const oldEmail = resolveEmail(userId);
    if (!oldEmail) return false;
    const profile = store.getUser(oldEmail);
    if (!profile) return false;

    const updated: StoredUser = { ...profile, email };

    if (oldEmail !== email) {
      store.setUser(oldEmail, undefined as unknown as StoredUser);
      if (profile.agentWallet) {
        walletCache.delete(oldEmail);
        walletCache.set(email, profile.agentWallet);
      }
    }

    store.setUser(email, updated);
    store.linkPlatform("telegram", userId, email);

    if (profile.agentWallet) {
      store.indexWallet(profile.agentWallet.address, email);
    }
    for (const ew of profile.externalWallets) {
      store.indexWallet(ew.address, email);
    }

    console.log("[keeperhub-wallet] linked email", email, "for user", userId);
    return true;
  }

  function getWallet(userId: string): PrivyWallet | undefined {
    const email = resolveEmail(userId);
    if (!email) return undefined;
    return walletCache.get(email);
  }

  function walletAddress(userId: string): string | undefined {
    const profile = getProfile(userId);
    if (!profile) return undefined;

    if (profile.activeWallet.kind === "agent") {
      return profile.agentWallet?.address ?? khAddress;
    }
    return profile.activeWallet.address;
  }

  function connectExternalWallet(userId: string, address: string, label?: string): void {
    const email = resolveEmail(userId);
    if (!email) return;
    const profile = store.getUser(email);
    if (!profile) return;

    const lower = address.toLowerCase();
    if (profile.externalWallets.some((w) => w.address.toLowerCase() === lower)) return;

    profile.externalWallets.push({
      address,
      label: label ?? `wallet-${profile.externalWallets.length + 1}`,
      connectedAt: Date.now(),
      delegated: false,
    });

    profile.activeWallet = { kind: "external", address };
    store.setUser(email, profile);
    store.indexWallet(address, email);
  }

  function disconnectExternalWallet(userId: string, address: string): boolean {
    const email = resolveEmail(userId);
    if (!email) return false;
    const profile = store.getUser(email);
    if (!profile) return false;

    const lower = address.toLowerCase();
    const idx = profile.externalWallets.findIndex((w) => w.address.toLowerCase() === lower);
    if (idx === -1) return false;

    profile.externalWallets.splice(idx, 1);
    store.unindexWallet(address);

    if (
      profile.activeWallet.kind === "external" &&
      profile.activeWallet.address.toLowerCase() === lower
    ) {
      profile.activeWallet = { kind: "agent" };
    }

    store.setUser(email, profile);
    return true;
  }

  function setActiveWallet(userId: string, ref: ActiveWalletRef): boolean {
    const email = resolveEmail(userId);
    if (!email) return false;
    const profile = store.getUser(email);
    if (!profile) return false;

    if (ref.kind === "external") {
      const found = profile.externalWallets.some(
        (w) => w.address.toLowerCase() === ref.address.toLowerCase(),
      );
      if (!found) return false;
    }

    profile.activeWallet = ref;
    store.setUser(email, profile);
    return true;
  }

  function setWalletMode(userId: string, mode: WalletMode): void {
    if (mode === "agent") {
      setActiveWallet(userId, { kind: "agent" });
    } else {
      const profile = getProfile(userId);
      if (profile && profile.externalWallets.length > 0) {
        setActiveWallet(userId, {
          kind: "external",
          address: profile.externalWallets[0]!.address,
        });
      }
    }
  }

  function getWalletConfig(userId: string): UserWalletConfig {
    const profile = getProfile(userId);
    if (!profile) {
      return {
        mode: "agent",
        agentWallet: null,
        externalAddress: null,
        activeAddress: null,
      };
    }
    const mode: WalletMode = profile.activeWallet.kind === "agent" ? "agent" : "external";
    const active = walletAddress(userId) ?? null;
    const externalAddress = profile.externalWallets[0]?.address ?? null;
    return { mode, agentWallet: profile.agentWallet, externalAddress, activeAddress: active };
  }

  function getFullWalletConfig(userId: string): FullWalletConfig | null {
    const profile = getProfile(userId);
    if (!profile) return null;
    return {
      email: profile.email,
      agentWallet: profile.agentWallet,
      externalWallets: profile.externalWallets,
      activeWallet: profile.activeWallet,
      activeAddress: walletAddress(userId) ?? null,
    };
  }

  function resolveByWalletAddress(address: string): string | undefined {
    return store.resolveByWallet(address);
  }

  function linkPlatform(platform: string, platformId: string, userId: string): void {
    const email = resolveEmail(userId);
    if (!email) return;
    store.linkPlatform(platform, platformId, email);
  }

  async function pollForCompletion(
    executionId: string,
    maxWaitMs: number,
  ): Promise<ExecutionStatus> {
    const start = Date.now();
    const interval = 2_000;
    while (Date.now() - start < maxWaitMs) {
      try {
        const status = await kh.getExecutionStatus(executionId);
        if (status.status === "completed" || status.status === "failed") return status;
      } catch {
        /* transient */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return { executionId, status: "pending" };
  }

  async function signTransaction(_userId: string, _tx: SignTxInput): Promise<string> {
    throw new Error("KeeperHub wallet does not support raw signing. Use sendTransaction.");
  }

  async function signTypedData(): Promise<string> {
    throw new Error(
      "KeeperHub wallet does not support EIP-712 typed-data signing. Permit2-gated swaps must route through the Privy wallet manager.",
    );
  }

  async function sendTransaction(_userId: string, tx: SignTxInput): Promise<SendTxResult> {
    const network = CHAIN_NUMERIC_TO_NAME[tx.chainId] ?? "ethereum";

    if (!tx.data || tx.data === "" || tx.data === "0x") {
      const weiStr = toDecimalWei(tx.value) ?? "0";
      const amount = weiToHumanReadable(weiStr);

      const result = await kh.transfer({
        network,
        recipientAddress: tx.to,
        amount,
      });

      if (result.status === "failed") {
        throw new Error("Transfer failed via KeeperHub");
      }

      const finalStatus = result.txHash
        ? result
        : await pollForCompletion(result.executionId, 30_000);
      return {
        hash: finalStatus.txHash ?? result.executionId,
        caip2: `eip155:${tx.chainId}`,
      };
    }

    const selector = getFunctionSelector(tx.data);

    if (selector === "095ea7b3") {
      const decoded = decodeApprove(tx.data);
      if (!decoded) throw new Error("Failed to decode approve calldata");

      const result = await kh.contractCall({
        contractAddress: tx.to,
        network,
        functionName: "approve",
        functionArgs: JSON.stringify(decoded.args),
        abi: ERC20_APPROVE_ABI,
      });

      if (result.status === "failed") {
        throw new Error("Token approval failed via KeeperHub");
      }

      const finalStatus = result.txHash
        ? result
        : await pollForCompletion(result.executionId, 30_000);
      return {
        hash: finalStatus.txHash ?? result.executionId,
        caip2: `eip155:${tx.chainId}`,
      };
    }

    if (selector === "3593564c") {
      const decoded = decodeUniversalRouterExecute(tx.data);
      if (!decoded) throw new Error("Failed to decode Universal Router calldata");

      const value = toDecimalWei(tx.value);

      const result = await kh.contractCall({
        contractAddress: tx.to,
        network,
        functionName: "execute",
        functionArgs: JSON.stringify(decoded.args),
        abi: UNIVERSAL_ROUTER_EXECUTE_ABI,
        ...(value && value !== "0" ? { value } : {}),
      });

      if (result.status === "failed") {
        throw new Error("Swap execution failed via KeeperHub");
      }

      const finalStatus = await pollForCompletion(result.executionId, 30_000);
      return {
        hash: finalStatus.txHash ?? result.executionId,
        caip2: `eip155:${tx.chainId}`,
      };
    }

    throw new Error(
      `Unsupported transaction type (selector: 0x${selector}). ` +
        `KeeperHub requires structured function calls.`,
    );
  }

  function getSolanaWallet(_userId: string): PrivyWallet | undefined {
    return undefined;
  }

  async function ensureSolanaWallet(_userId: string): Promise<PrivyWallet | null> {
    return null;
  }

  return {
    getOrCreateWallet,
    createWalletWithEmail,
    linkEmail,
    getWallet,
    getSolanaWallet,
    ensureSolanaWallet,
    walletAddress,
    signTransaction,
    signTypedData,
    sendTransaction,
    connectExternalWallet,
    disconnectExternalWallet,
    setWalletMode,
    setActiveWallet,
    getWalletConfig,
    getFullWalletConfig,
    resolveByWalletAddress,
    linkPlatform,
    getClient: () => {
      throw new Error("KeeperHub wallet does not expose a Privy client");
    },
  };
}
