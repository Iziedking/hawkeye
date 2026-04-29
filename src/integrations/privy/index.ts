import { PrivyClient } from "@privy-io/node";
import { loadEnvLocal, envOr } from "../../shared/env";
import { JsonStore } from "../../shared/store";
import type { ChainId } from "../../shared/types";

loadEnvLocal();

const CAIP2_MAP: Partial<Record<ChainId, string>> = {
  ethereum: "eip155:1",
  bsc: "eip155:56",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  base: "eip155:8453",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
  blast: "eip155:81457",
  zksync: "eip155:324",
  celo: "eip155:42220",
  scroll: "eip155:534352",
  linea: "eip155:59144",
  mantle: "eip155:5000",
  fantom: "eip155:250",
  cronos: "eip155:25",
};

const CHAIN_NUMERIC_TO_ID: Record<number, ChainId> = {
  1: "ethereum",
  56: "bsc",
  137: "polygon",
  42161: "arbitrum",
  8453: "base",
  10: "optimism",
  43114: "avalanche",
  81457: "blast",
  324: "zksync",
  42220: "celo",
  534352: "scroll",
  59144: "linea",
  5000: "mantle",
  250: "fantom",
  25: "cronos",
};

export type PrivyWallet = {
  walletId: string;
  address: string;
  chainType: string;
  createdAt: number;
};

export type WalletManagerDeps = {
  appId?: string;
  appSecret?: string;
};

export type WalletMode = "agent" | "external";

export type UserWalletConfig = {
  mode: WalletMode;
  agentWallet: PrivyWallet | null;
  externalAddress: string | null;
  activeAddress: string | null;
};

export type WalletManager = {
  getOrCreateWallet: (userId: string) => Promise<PrivyWallet>;
  getWallet: (userId: string) => PrivyWallet | undefined;
  walletAddress: (userId: string) => string | undefined;
  signTransaction: (userId: string, tx: SignTxInput) => Promise<string>;
  sendTransaction: (userId: string, tx: SignTxInput) => Promise<SendTxResult>;
  connectExternalWallet: (userId: string, address: string) => void;
  setWalletMode: (userId: string, mode: WalletMode) => void;
  getWalletConfig: (userId: string) => UserWalletConfig;
  getClient: () => PrivyClient;
};

export type SignTxInput = {
  to: string;
  value?: number | string;
  data?: string;
  chainId: number;
  gasLimit?: string;
};

export type SendTxResult = {
  hash: string;
  caip2: string;
};

export function createWalletManager(deps: WalletManagerDeps = {}): WalletManager {
  const appId = deps.appId ?? envOr("PRIVY_APP_ID", "");
  const appSecret = deps.appSecret ?? envOr("PRIVY_APP_SECRET", "");

  if (!appId || !appSecret) {
    throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET required. Set them in .env.local");
  }

  const client = new PrivyClient({ appId, appSecret });
  const store = new JsonStore();

  // Hydrate in-memory cache from persistent store
  const wallets = new Map<string, PrivyWallet>();
  const externalWallets = new Map<string, string>();
  const walletModes = new Map<string, WalletMode>();

  for (const [uid, stored] of Object.entries(store.allUsers())) {
    if (stored.agentWallet) {
      wallets.set(uid, stored.agentWallet);
    }
    if (stored.externalAddress) {
      externalWallets.set(uid, stored.externalAddress);
    }
    walletModes.set(uid, stored.mode);
  }
  const restored = wallets.size;
  if (restored > 0) console.log(`[privy] restored ${restored} wallet(s) from disk`);

  async function getOrCreateWallet(userId: string): Promise<PrivyWallet> {
    const existing = wallets.get(userId);
    if (existing) return existing;

    const wallet = await client.wallets().create({
      chain_type: "ethereum",
    });

    const pw: PrivyWallet = {
      walletId: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type,
      createdAt: Date.now(),
    };

    wallets.set(userId, pw);
    store.updateUser(userId, { agentWallet: pw });
    console.log("[privy] created wallet for", userId, "→", wallet.address);
    return pw;
  }

  function getWallet(userId: string): PrivyWallet | undefined {
    return wallets.get(userId);
  }

  function walletAddress(userId: string): string | undefined {
    const mode = walletModes.get(userId) ?? "agent";
    if (mode === "external") return externalWallets.get(userId);
    return wallets.get(userId)?.address;
  }

  function connectExternalWallet(userId: string, address: string): void {
    externalWallets.set(userId, address);
    walletModes.set(userId, "external");
    store.updateUser(userId, { externalAddress: address, mode: "external" });
    console.log("[privy] external wallet connected for", userId, "→", address);
  }

  function setWalletMode(userId: string, mode: WalletMode): void {
    walletModes.set(userId, mode);
    store.updateUser(userId, { mode });
    console.log("[privy] wallet mode set to", mode, "for", userId);
  }

  function getWalletConfig(userId: string): UserWalletConfig {
    const mode = walletModes.get(userId) ?? "agent";
    const agentWallet = wallets.get(userId) ?? null;
    const externalAddress = externalWallets.get(userId) ?? null;
    const activeAddress = mode === "external" ? externalAddress : (agentWallet?.address ?? null);
    return { mode, agentWallet, externalAddress, activeAddress };
  }

  function resolveWallet(userId: string): PrivyWallet {
    const w = wallets.get(userId);
    if (!w) throw new Error(`No wallet for user ${userId}. Call getOrCreateWallet first.`);
    return w;
  }

  function resolveCaip2(chainNumeric: number): string {
    const chainId = CHAIN_NUMERIC_TO_ID[chainNumeric];
    if (!chainId) throw new Error(`Unsupported numeric chain: ${chainNumeric}`);
    const caip2 = CAIP2_MAP[chainId];
    if (!caip2) throw new Error(`No CAIP-2 mapping for chain: ${chainId}`);
    return caip2;
  }

  async function signTransaction(userId: string, tx: SignTxInput): Promise<string> {
    const w = resolveWallet(userId);

    const txObj: Record<string, unknown> = {
      to: tx.to,
      chain_id: tx.chainId,
    };
    if (tx.value !== undefined) txObj.value = tx.value;
    if (tx.data) txObj.data = tx.data;
    if (tx.gasLimit) txObj.gas_limit = tx.gasLimit;

    const result = await client
      .wallets()
      .ethereum()
      .signTransaction(w.walletId, {
        params: { transaction: txObj as any },
      });

    return result.signed_transaction;
  }

  // Direct send via Privy (bypasses KeeperHub). Use for simple transfers
  // or when KeeperHub is unavailable. For trade execution, prefer
  // signTransaction + KeeperHub submission for MEV protection.
  async function sendTransaction(userId: string, tx: SignTxInput): Promise<SendTxResult> {
    const w = resolveWallet(userId);
    const caip2 = resolveCaip2(tx.chainId);

    const txObj: Record<string, unknown> = {
      to: tx.to,
      chain_id: tx.chainId,
    };
    if (tx.value !== undefined) txObj.value = tx.value;
    if (tx.data) txObj.data = tx.data;
    if (tx.gasLimit) txObj.gas_limit = tx.gasLimit;

    const result = await client
      .wallets()
      .ethereum()
      .sendTransaction(w.walletId, {
        caip2,
        params: { transaction: txObj as any },
      });

    return { hash: result.hash, caip2: result.caip2 };
  }

  return {
    getOrCreateWallet,
    getWallet,
    walletAddress,
    signTransaction,
    sendTransaction,
    connectExternalWallet,
    setWalletMode,
    getWalletConfig,
    getClient: () => client,
  };
}

export function caip2ForChain(chainId: ChainId): string | undefined {
  return CAIP2_MAP[chainId];
}

export function chainIdFromNumeric(numeric: number): ChainId | undefined {
  return CHAIN_NUMERIC_TO_ID[numeric];
}
