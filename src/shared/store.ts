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

export class JsonStore {
  private readonly path: string;
  private data: StoreData;

  constructor(path?: string) {
    this.path = path ?? DEFAULT_PATH;
    this.data = this.load();
  }

  private load(): StoreData {
    if (!existsSync(this.path)) {
      return { users: {} };
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      return JSON.parse(raw) as StoreData;
    } catch {
      return { users: {} };
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Atomic write: writing to a sibling tmp file and then renaming guarantees
    // readers never see a half-written users.json. A crash mid-write only
    // leaves an orphan .tmp file behind.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
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
