import { createPrivateKey, createPublicKey } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { loadEnvLocal, envOr } from "../../shared/env";
import { log } from "../../shared/logger";
import { JsonStore } from "../../shared/store";
import type { StoredUser, StoredExternalWallet, StoredActiveWallet } from "../../shared/store";
import type { ChainId, ActiveWalletRef } from "../../shared/types";

loadEnvLocal();

// Derives the SPKI/base64 P-256 public key from the PKCS8 private key in
// PRIVY_AUTHORIZATION_PRIVATE_KEY. Privy expects this exact encoding when
// stamping ownership via `owner: { public_key }` (matches the format that
// the SDK's own generateP256KeyPair() produces — base64-encoded SPKI DER).
function derivePrivyAuthPublicKey(privateKeyB64: string): string {
  const stripped = privateKeyB64.replace(/^wallet-auth:|^wallet-api:/, "");
  const der = Buffer.from(stripped, "base64");
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv);
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

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
  sepolia: "eip155:11155111",
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
  11155111: "sepolia",
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

export type FullWalletConfig = {
  email: string;
  agentWallet: PrivyWallet | null;
  externalWallets: StoredExternalWallet[];
  activeWallet: StoredActiveWallet;
  activeAddress: string | null;
};

export type WalletManager = {
  getOrCreateWallet: (userId: string) => Promise<PrivyWallet>;
  createWalletWithEmail: (userId: string, email: string) => Promise<PrivyWallet>;
  linkEmail: (userId: string, email: string) => Promise<boolean>;
  getWallet: (userId: string) => PrivyWallet | undefined;
  getSolanaWallet: (userId: string) => PrivyWallet | undefined;
  ensureSolanaWallet: (userId: string) => Promise<PrivyWallet | null>;
  walletAddress: (userId: string) => string | undefined;
  signTransaction: (userId: string, tx: SignTxInput) => Promise<string>;
  sendTransaction: (userId: string, tx: SignTxInput) => Promise<SendTxResult>;
  connectExternalWallet: (userId: string, address: string, label?: string) => void;
  disconnectExternalWallet: (userId: string, address: string) => boolean;
  setWalletMode: (userId: string, mode: WalletMode) => void;
  setActiveWallet: (userId: string, ref: ActiveWalletRef) => boolean;
  getWalletConfig: (userId: string) => UserWalletConfig;
  getFullWalletConfig: (userId: string) => FullWalletConfig | null;
  resolveByWalletAddress: (address: string) => string | undefined;
  linkPlatform: (platform: string, platformId: string, userId: string) => void;
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

  // Server-wallet signing requires an Authorization Key configured in the
  // Privy dashboard. The base64-PKCS8 private key is passed per request as
  // `authorization_context.authorization_private_keys`. Without it,
  // `sendTransaction` returns 401 "No valid authorization keys or user
  // signing keys available".
  const authPrivateKey = envOr("PRIVY_AUTHORIZATION_PRIVATE_KEY", "");
  const authContext: { authorization_private_keys: string[] } | undefined =
    authPrivateKey.length > 0 ? { authorization_private_keys: [authPrivateKey] } : undefined;

  // Public counterpart of the auth key. Stamped onto every newly created
  // wallet via `owner: { public_key }` so the bot's auth private key is the
  // sole authorized signer for that wallet (Path B). Without it, wallets
  // would have no recognized signer and signing requests would 401.
  const authPublicKey: string | null =
    authPrivateKey.length > 0 ? derivePrivyAuthPublicKey(authPrivateKey) : null;

  const client = new PrivyClient({ appId, appSecret });
  const store = new JsonStore();

  // In-memory cache of agent wallets for fast lookups
  const walletCache = new Map<string, PrivyWallet>();
  const solanaWalletCache = new Map<string, PrivyWallet>();

  // Hydrate cache from store
  for (const [email, user] of Object.entries(store.allUsers())) {
    if (user.agentWallet) {
      walletCache.set(email, user.agentWallet);
    }
    if (user.solanaWallet) {
      solanaWalletCache.set(email, user.solanaWallet);
    }
  }
  const restored = walletCache.size;
  const restoredSol = solanaWalletCache.size;
  if (restored > 0)
    log.privy(`restored ${restored} EVM + ${restoredSol} Solana wallet(s) from disk`);

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

    const evmOpts: Record<string, unknown> = { chain_type: "ethereum" };
    if (authPublicKey) evmOpts["owner"] = { public_key: authPublicKey };
    const wallet = await client.wallets().create(evmOpts as { chain_type: "ethereum" });

    const pw: PrivyWallet = {
      walletId: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type,
      createdAt: Date.now(),
    };

    if (profile) {
      profile.agentWallet = pw;
      store.setUser(email, profile);
    } else {
      const newProfile: StoredUser = {
        v: 2,
        email,
        privyUserId: null,
        platformIds: [{ platform: "telegram", id: userId }],
        agentWallet: pw,
        solanaWallet: null,
        externalWallets: [],
        activeWallet: { kind: "agent" },
        createdAt: Date.now(),
      };
      store.setUser(email, newProfile);
      store.linkPlatform("telegram", userId, email);
    }

    store.indexWallet(pw.address, email);
    walletCache.set(email, pw);
    console.log("[privy] created EVM wallet for", userId, "→", wallet.address);

    // Create Solana wallet in background (don't block EVM wallet return)
    void createSolanaWalletForEmail(email).catch((err) => {
      console.warn(
        "[privy] background Solana wallet creation failed:",
        (err as Error).message?.slice(0, 80),
      );
    });

    return pw;
  }

  async function createSolanaWalletForEmail(email: string): Promise<PrivyWallet | null> {
    const profile = store.getUser(email);
    if (!profile) return null;
    if (profile.solanaWallet) return profile.solanaWallet;

    try {
      const solOpts: Record<string, unknown> = { chain_type: "solana" };
      if (authPublicKey) solOpts["owner"] = { public_key: authPublicKey };
      const wallet = await client.wallets().create(solOpts as { chain_type: "solana" });

      const sw: PrivyWallet = {
        walletId: wallet.id,
        address: wallet.address,
        chainType: wallet.chain_type,
        createdAt: Date.now(),
      };

      profile.solanaWallet = sw;
      store.setUser(email, profile);
      store.indexWallet(sw.address, email);
      solanaWalletCache.set(email, sw);
      console.log("[privy] created Solana wallet for", email, "→", wallet.address);
      return sw;
    } catch (err) {
      console.warn("[privy] Solana wallet creation failed:", (err as Error).message?.slice(0, 80));
      return null;
    }
  }

  async function ensureSolanaWallet(userId: string): Promise<PrivyWallet | null> {
    const email = resolveEmail(userId);
    if (!email) return null;
    const cached = solanaWalletCache.get(email);
    if (cached) return cached;
    return createSolanaWalletForEmail(email);
  }

  function getSolanaWallet(userId: string): PrivyWallet | undefined {
    const email = resolveEmail(userId);
    if (!email) return undefined;
    return solanaWalletCache.get(email);
  }

  async function createWalletWithEmail(userId: string, email: string): Promise<PrivyWallet> {
    const existing = resolveEmail(userId);
    if (existing) {
      const profile = store.getUser(existing);
      if (profile?.agentWallet) return profile.agentWallet;
    }

    const walletOpts: Record<string, unknown> = { chain_type: "ethereum" };
    if (authPublicKey) walletOpts["owner"] = { public_key: authPublicKey };
    const wallet = await client.wallets().create(walletOpts as { chain_type: "ethereum" });

    const pw: PrivyWallet = {
      walletId: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type,
      createdAt: Date.now(),
    };

    const newProfile: StoredUser = {
      v: 2,
      email,
      privyUserId: null,
      platformIds: [{ platform: "telegram", id: userId }],
      agentWallet: pw,
      solanaWallet: null,
      externalWallets: [],
      activeWallet: { kind: "agent" },
      createdAt: Date.now(),
    };

    // If there was an old synthetic profile, clean it up
    if (existing && existing !== email) {
      const oldProfile = store.getUser(existing);
      if (oldProfile) {
        newProfile.externalWallets = oldProfile.externalWallets;
        newProfile.platformIds = oldProfile.platformIds;
        store.deleteUser(existing);
      }
      walletCache.delete(existing);
      solanaWalletCache.delete(existing);
    }

    store.setUser(email, newProfile);
    store.linkPlatform("telegram", userId, email);
    store.indexWallet(pw.address, email);
    walletCache.set(email, pw);

    console.log("[privy] created EVM wallet for", email, "→", wallet.address);

    // Create Solana wallet in background
    void createSolanaWalletForEmail(email).catch((err) => {
      console.warn(
        "[privy] background Solana wallet creation failed:",
        (err as Error).message?.slice(0, 80),
      );
    });

    return pw;
  }

  async function linkEmail(userId: string, email: string): Promise<boolean> {
    const oldEmail = resolveEmail(userId);
    if (!oldEmail) return false;
    const profile = store.getUser(oldEmail);
    if (!profile) return false;

    // Re-key profile from old (synthetic) email to real email. We no longer
    // create a Privy user record here — wallet ownership is bound to the
    // bot's authorization key, not a Privy user.
    const updated: StoredUser = {
      ...profile,
      email,
    };

    // Delete old entry if different key
    if (oldEmail !== email) {
      store.setUser(oldEmail, undefined as unknown as StoredUser);
      if (profile.agentWallet) {
        walletCache.delete(oldEmail);
        walletCache.set(email, profile.agentWallet);
      }
      if (profile.solanaWallet) {
        solanaWalletCache.delete(oldEmail);
        solanaWalletCache.set(email, profile.solanaWallet);
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

    console.log("[privy] linked email", email, "for user", userId);
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
      return profile.agentWallet?.address;
    }
    return profile.activeWallet.address;
  }

  function connectExternalWallet(userId: string, address: string, label?: string): void {
    const email = resolveEmail(userId);
    if (!email) return;
    const profile = store.getUser(email);
    if (!profile) return;

    const lower = address.toLowerCase();
    if (profile.externalWallets.some((w) => w.address.toLowerCase() === lower)) {
      return;
    }

    profile.externalWallets.push({
      address,
      label: label ?? `wallet-${profile.externalWallets.length + 1}`,
      connectedAt: Date.now(),
      delegated: false,
    });

    profile.activeWallet = { kind: "external", address };
    store.setUser(email, profile);
    store.indexWallet(address, email);
    console.log("[privy] external wallet connected for", userId, "→", address);
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
    console.log("[privy] external wallet disconnected for", userId, "→", address);
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
    console.log("[privy] active wallet set to", ref.kind, "for", userId);
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
      return { mode: "agent", agentWallet: null, externalAddress: null, activeAddress: null };
    }

    const mode: WalletMode = profile.activeWallet.kind === "agent" ? "agent" : "external";
    const active = walletAddress(userId) ?? null;
    const externalAddress = profile.externalWallets[0]?.address ?? null;

    return {
      mode,
      agentWallet: profile.agentWallet,
      externalAddress,
      activeAddress: active,
    };
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

  function resolveAgentWallet(userId: string): PrivyWallet {
    const email = resolveEmail(userId);
    const pw = email ? walletCache.get(email) : undefined;
    if (!pw) throw new Error(`No agent wallet for user ${userId}. Call getOrCreateWallet first.`);
    return pw;
  }

  function resolveCaip2(chainNumeric: number): string {
    const chainId = CHAIN_NUMERIC_TO_ID[chainNumeric];
    if (!chainId) throw new Error(`Unsupported numeric chain: ${chainNumeric}`);
    const caip2 = CAIP2_MAP[chainId];
    if (!caip2) throw new Error(`No CAIP-2 mapping for chain: ${chainId}`);
    return caip2;
  }

  async function signTransaction(userId: string, tx: SignTxInput): Promise<string> {
    const w = resolveAgentWallet(userId);

    const txObj: Record<string, unknown> = {
      to: tx.to,
      chain_id: tx.chainId,
    };
    if (tx.value !== undefined) txObj["value"] = toHex(tx.value);
    if (tx.data) txObj["data"] = tx.data;
    if (tx.gasLimit) txObj["gas_limit"] = toHex(tx.gasLimit);

    const result = await client
      .wallets()
      .ethereum()
      .signTransaction(w.walletId, {
        params: { transaction: txObj as Record<string, unknown> },
        ...(authContext ? { authorization_context: authContext } : {}),
      });

    return result.signed_transaction;
  }

  function toHex(val: number | string): string {
    const n = typeof val === "string" ? BigInt(val) : BigInt(Math.floor(val));
    return "0x" + n.toString(16);
  }

  async function sendTransaction(userId: string, tx: SignTxInput): Promise<SendTxResult> {
    const w = resolveAgentWallet(userId);
    const caip2 = resolveCaip2(tx.chainId);

    const txObj: Record<string, unknown> = {
      to: tx.to,
      chain_id: tx.chainId,
    };
    if (tx.value !== undefined) txObj["value"] = toHex(tx.value);
    if (tx.data) txObj["data"] = tx.data;
    if (tx.gasLimit) txObj["gas_limit"] = toHex(tx.gasLimit);

    try {
      const result = await client
        .wallets()
        .ethereum()
        .sendTransaction(w.walletId, {
          caip2,
          params: { transaction: txObj as Record<string, unknown> },
          ...(authContext ? { authorization_context: authContext } : {}),
        });
      return { hash: result.hash, caip2: result.caip2 };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Surface a clear hint for the most common Privy 401: missing
      // Authorization Key. The user fixes this by registering an
      // authorization key in the Privy dashboard and setting
      // PRIVY_AUTHORIZATION_PRIVATE_KEY in .env.local.
      if (msg.includes("No valid authorization keys") || msg.includes("user signing keys")) {
        throw new Error(
          "Wallet signing isn't authorized. Set up an Authorization Key in your Privy dashboard (Settings → Authorization Keys) and add the base64 private key as PRIVY_AUTHORIZATION_PRIVATE_KEY in .env.local. See https://docs.privy.io/wallets/using-wallets/authorization-keys",
        );
      }
      throw err;
    }
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
    sendTransaction,
    connectExternalWallet,
    disconnectExternalWallet,
    setWalletMode,
    setActiveWallet,
    getWalletConfig,
    getFullWalletConfig,
    resolveByWalletAddress,
    linkPlatform,
    getClient: () => client,
  };
}

export function caip2ForChain(chainId: ChainId): string | undefined {
  return CAIP2_MAP[chainId];
}

export function chainIdFromNumeric(numeric: number): ChainId | undefined {
  return CHAIN_NUMERIC_TO_ID[numeric];
}
