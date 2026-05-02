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

export type WalletProvider = "keeperhub" | "privy";

export type DualWalletManager = WalletManager & {
  setProvider: (userId: string, provider: WalletProvider) => void;
  getProvider: (userId: string) => WalletProvider;
  hasKeeperHub: () => boolean;
  hasPrivy: () => boolean;
};

const KH_WALLET_PREFIX = "keeperhub-";

export function createDualWalletManager(
  khWm: WalletManager | null,
  privyWm: WalletManager | null,
): DualWalletManager {
  if (!khWm && !privyWm) {
    throw new Error("At least one wallet manager (KeeperHub or Privy) is required");
  }

  const providerOverrides = new Map<string, WalletProvider>();

  function detectProvider(userId: string): WalletProvider {
    const override = providerOverrides.get(userId);
    if (override) return override;

    if (khWm) {
      const w = khWm.getWallet(userId);
      if (w && w.walletId.startsWith(KH_WALLET_PREFIX)) return "keeperhub";
    }
    if (privyWm) {
      const w = privyWm.getWallet(userId);
      if (w && !w.walletId.startsWith(KH_WALLET_PREFIX)) return "privy";
    }

    return khWm ? "keeperhub" : "privy";
  }

  function getManager(userId: string): WalletManager {
    const provider = detectProvider(userId);
    if (provider === "keeperhub" && khWm) return khWm;
    if (provider === "privy" && privyWm) return privyWm;
    return khWm ?? privyWm!;
  }

  function setProvider(userId: string, provider: WalletProvider): void {
    providerOverrides.set(userId, provider);
  }

  function getProvider(userId: string): WalletProvider {
    return detectProvider(userId);
  }

  return {
    setProvider,
    getProvider,
    hasKeeperHub: () => khWm !== null,
    hasPrivy: () => privyWm !== null,

    async getOrCreateWallet(userId: string): Promise<PrivyWallet> {
      return getManager(userId).getOrCreateWallet(userId);
    },

    async createWalletWithEmail(userId: string, email: string): Promise<PrivyWallet> {
      return getManager(userId).createWalletWithEmail(userId, email);
    },

    async linkEmail(userId: string, email: string): Promise<boolean> {
      return getManager(userId).linkEmail(userId, email);
    },

    getWallet(userId: string): PrivyWallet | undefined {
      if (khWm) {
        const w = khWm.getWallet(userId);
        if (w) return w;
      }
      if (privyWm) {
        const w = privyWm.getWallet(userId);
        if (w) return w;
      }
      return undefined;
    },

    getSolanaWallet(userId: string): PrivyWallet | undefined {
      return getManager(userId).getSolanaWallet(userId);
    },

    async ensureSolanaWallet(userId: string): Promise<PrivyWallet | null> {
      return getManager(userId).ensureSolanaWallet(userId);
    },

    walletAddress(userId: string): string | undefined {
      return getManager(userId).walletAddress(userId);
    },

    async signTransaction(userId: string, tx: SignTxInput): Promise<string> {
      return getManager(userId).signTransaction(userId, tx);
    },

    async sendTransaction(userId: string, tx: SignTxInput): Promise<SendTxResult> {
      return getManager(userId).sendTransaction(userId, tx);
    },

    connectExternalWallet(userId: string, address: string, label?: string): void {
      getManager(userId).connectExternalWallet(userId, address, label);
    },

    disconnectExternalWallet(userId: string, address: string): boolean {
      return getManager(userId).disconnectExternalWallet(userId, address);
    },

    setWalletMode(userId: string, mode: WalletMode): void {
      getManager(userId).setWalletMode(userId, mode);
    },

    setActiveWallet(userId: string, ref: ActiveWalletRef): boolean {
      return getManager(userId).setActiveWallet(userId, ref);
    },

    getWalletConfig(userId: string): UserWalletConfig {
      return getManager(userId).getWalletConfig(userId);
    },

    getFullWalletConfig(userId: string): FullWalletConfig | null {
      return getManager(userId).getFullWalletConfig(userId);
    },

    resolveByWalletAddress(address: string): string | undefined {
      const fromKh = khWm?.resolveByWalletAddress(address);
      if (fromKh) return fromKh;
      return privyWm?.resolveByWalletAddress(address);
    },

    linkPlatform(platform: string, platformId: string, userId: string): void {
      getManager(userId).linkPlatform(platform, platformId, userId);
    },

    getClient() {
      if (privyWm) return privyWm.getClient();
      throw new Error("No Privy client available — using KeeperHub wallet");
    },
  };
}
