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

export type StoredUser = {
  agentWallet: StoredWallet | null;
  externalAddress: string | null;
  mode: "agent" | "external";
};

export type StoreData = {
  users: Record<string, StoredUser>;
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
  }

  private load(): StoreData {
    if (!existsSync(this.path)) return { users: {} };
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isEncrypted(parsed)) {
        if (!this.masterKey) {
          throw new Error("Encrypted store found but HAWKEYE_MASTER_KEY not set");
        }
        return JSON.parse(decryptStore(parsed, this.masterKey)) as StoreData;
      }
      return parsed as StoreData;
    } catch (err) {
      console.error("[store] load failed:", (err as Error).message);
      return { users: {} };
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

  getUser(userId: string): StoredUser | undefined {
    return this.data.users[userId];
  }

  setUser(userId: string, user: StoredUser): void {
    this.data.users[userId] = user;
    this.save();
  }

  updateUser(userId: string, partial: Partial<StoredUser>): void {
    const existing = this.data.users[userId] ?? {
      agentWallet: null,
      externalAddress: null,
      mode: "agent" as const,
    };
    this.data.users[userId] = { ...existing, ...partial };
    this.save();
  }

  allUsers(): Record<string, StoredUser> {
    return this.data.users;
  }
}
