import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  type CipherGCMTypes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";

export type StoredWallet = {
  walletId: string;
  address: string;
  chainType: string;
  createdAt: number;
};

export type StoredExternalWallet = {
  address: string;
  label: string;
  connectedAt: number;
  delegated: boolean;
};

export type StoredActiveWallet =
  | { kind: "agent" }
  | { kind: "external"; address: string };

// V1 format (pre-upgrade) -- kept for migration detection
type StoredUserV1 = {
  agentWallet: StoredWallet | null;
  externalAddress: string | null;
  mode: "agent" | "external";
};

export type StoredUser = {
  v: 2;
  email: string;
  privyUserId: string | null;
  platformIds: Array<{ platform: string; id: string }>;
  agentWallet: StoredWallet | null;
  solanaWallet: StoredWallet | null;
  externalWallets: StoredExternalWallet[];
  activeWallet: StoredActiveWallet;
  createdAt: number;
};

export type StoreData = {
  users: Record<string, StoredUser>;
  platformIndex: Record<string, string>;
  walletIndex: Record<string, string>;
};

const DEFAULT_PATH = resolve(process.cwd(), "data", "users.json");

const ALGO: CipherGCMTypes = "aes-256-gcm";
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

type EncryptedEnvelope = {
  encrypted: true;
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);
}

function encryptStore(plaintext: string, passphrase: string): EncryptedEnvelope {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return {
    encrypted: true,
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: enc.toString("hex"),
  };
}

function decryptStore(envelope: EncryptedEnvelope, passphrase: string): string {
  const salt = Buffer.from(envelope.salt, "hex");
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(envelope.iv, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "hex")),
    decipher.final(),
  ]).toString("utf-8");
}

function isEncrypted(obj: unknown): obj is EncryptedEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return r["encrypted"] === true && r["version"] === 1;
}

function isV2User(user: unknown): user is StoredUser {
  return typeof user === "object" && user !== null && (user as { v?: number }).v === 2;
}

const EMPTY_DATA: StoreData = { users: {}, platformIndex: {}, walletIndex: {} };

export class JsonStore {
  private readonly path: string;
  private readonly masterKey: string | null;
  private data: StoreData;

  constructor(path?: string) {
    this.path = path ?? DEFAULT_PATH;
    const mk = process.env["HAWKEYE_MASTER_KEY"];
    this.masterKey = mk && mk.length > 0 ? mk : null;
    if (!this.masterKey) {
      console.warn("[store] HAWKEYE_MASTER_KEY not set — wallet data stored unencrypted");
    }
    this.data = this.load();
    this.migrate();
  }

  private load(): StoreData {
    if (!existsSync(this.path)) return { ...EMPTY_DATA };
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isEncrypted(parsed)) {
        if (!this.masterKey) {
          throw new Error("Encrypted store found but HAWKEYE_MASTER_KEY not set");
        }
        const decrypted = JSON.parse(decryptStore(parsed, this.masterKey)) as Record<string, unknown>;
        return {
          users: (decrypted["users"] ?? {}) as Record<string, StoredUser>,
          platformIndex: (decrypted["platformIndex"] ?? {}) as Record<string, string>,
          walletIndex: (decrypted["walletIndex"] ?? {}) as Record<string, string>,
        };
      }
      const obj = parsed as Record<string, unknown>;
      return {
        users: (obj["users"] ?? {}) as Record<string, StoredUser>,
        platformIndex: (obj["platformIndex"] ?? {}) as Record<string, string>,
        walletIndex: (obj["walletIndex"] ?? {}) as Record<string, string>,
      };
    } catch (err) {
      console.error("[store] load failed:", (err as Error).message);
      return { ...EMPTY_DATA };
    }
  }

  private migrate(): void {
    let dirty = false;

    for (const [key, user] of Object.entries(this.data.users)) {
      if (isV2User(user)) continue;

      const v1 = user as unknown as StoredUserV1;
      const email = `${key}@hawkeye.local`;

      const externalWallets: StoredExternalWallet[] = [];
      if (v1.externalAddress) {
        externalWallets.push({
          address: v1.externalAddress,
          label: "default",
          connectedAt: Date.now(),
          delegated: false,
        });
      }

      const activeWallet: StoredActiveWallet =
        v1.mode === "external" && v1.externalAddress
          ? { kind: "external", address: v1.externalAddress }
          : { kind: "agent" };

      const migrated: StoredUser = {
        v: 2,
        email,
        privyUserId: null,
        platformIds: [{ platform: "telegram", id: key }],
        agentWallet: v1.agentWallet,
        solanaWallet: null,
        externalWallets,
        activeWallet,
        createdAt: Date.now(),
      };

      delete this.data.users[key];
      this.data.users[email] = migrated;
      this.data.platformIndex[`telegram:${key}`] = email;

      if (v1.agentWallet) {
        this.data.walletIndex[v1.agentWallet.address.toLowerCase()] = email;
      }
      if (v1.externalAddress) {
        this.data.walletIndex[v1.externalAddress.toLowerCase()] = email;
      }
      dirty = true;
    }

    // Backfill solanaWallet for existing V2 users loaded from older data
    for (const user of Object.values(this.data.users)) {
      if (isV2User(user) && !("solanaWallet" in user)) {
        (user as StoredUser).solanaWallet = null;
        dirty = true;
      }
    }

    if (dirty) {
      const count = Object.keys(this.data.users).length;
      console.log(`[store] migrated ${count} user(s) to V2 schema`);
      this.save();
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(this.data, null, 2);
    const content = this.masterKey
      ? JSON.stringify(encryptStore(json, this.masterKey), null, 2)
      : json;

    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, this.path);
  }

  // --- Profile resolution ---

  resolveProfile(platform: string, platformId: string): string | undefined {
    return this.data.platformIndex[`${platform}:${platformId}`];
  }

  resolveByWallet(address: string): string | undefined {
    return this.data.walletIndex[address.toLowerCase()];
  }

  // --- User CRUD ---

  getUser(email: string): StoredUser | undefined {
    return this.data.users[email];
  }

  setUser(email: string, user: StoredUser): void {
    this.data.users[email] = user;
    this.save();
  }

  deleteUser(email: string): void {
    delete this.data.users[email];
    this.save();
  }

  updateUser(email: string, partial: Partial<StoredUser>): void {
    const existing = this.data.users[email];
    if (!existing) return;
    this.data.users[email] = { ...existing, ...partial };
    this.save();
  }

  allUsers(): Record<string, StoredUser> {
    return this.data.users;
  }

  // --- Index management ---

  linkPlatform(platform: string, platformId: string, email: string): void {
    this.data.platformIndex[`${platform}:${platformId}`] = email;
    this.save();
  }

  indexWallet(address: string, email: string): void {
    this.data.walletIndex[address.toLowerCase()] = email;
    this.save();
  }

  unindexWallet(address: string): void {
    delete this.data.walletIndex[address.toLowerCase()];
    this.save();
  }
}
