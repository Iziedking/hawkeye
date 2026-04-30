import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { envOr, requireEnv } from "../../shared/env";

const DEFAULT_RPC_URL = "https://evmrpc-testnet.0g.ai";
const DEFAULT_INDEXER_URL = "https://indexer-storage-testnet-turbo.0g.ai";

export type OgStorageWriteResult = {
  rootHash: string;
  txHash: string;
  txSeq: number;
  byteLength: number;
};

export type OgStorageErrorReason =
  | "INDEXER_UNREACHABLE"
  | "UPLOAD_FAILED"
  | "FRAGMENTED_UNEXPECTED"
  | "UNKNOWN";

export class OgStorageError extends Error {
  readonly reason: OgStorageErrorReason;
  constructor(reason: OgStorageErrorReason, message: string, cause?: unknown) {
    super(message);
    this.name = "OgStorageError";
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type OgStorageClientOptions = {
  privateKey?: string;
  rpcUrl?: string;
  indexerUrl?: string;
};

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1_000;

export class OgStorageClient {
  private readonly signer: ethers.Wallet;
  private readonly indexer: Indexer;
  private readonly rpcUrl: string;

  private consecutiveFailures = 0;
  private circuitOpenSince = 0;

  constructor(opts: OgStorageClientOptions = {}) {
    const privateKey = opts.privateKey ?? requireEnv("HAWKEYE_EVM_PRIVATE_KEY");
    this.rpcUrl = opts.rpcUrl ?? envOr("OG_RPC_URL", DEFAULT_RPC_URL);
    const indexerUrl = opts.indexerUrl ?? envOr("OG_INDEXER_URL", DEFAULT_INDEXER_URL);

    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, provider);
    this.indexer = new Indexer(indexerUrl);
  }

  get circuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    const elapsed = Date.now() - this.circuitOpenSince;
    if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      this.consecutiveFailures = 0;
      this.circuitOpenSince = 0;
      console.log("[0g-storage] circuit half-open — retrying writes");
      return false;
    }
    return true;
  }

  async writeJson(key: string, obj: unknown): Promise<OgStorageWriteResult> {
    if (this.circuitOpen) {
      throw new OgStorageError(
        "INDEXER_UNREACHABLE",
        `circuit open — skipping write for "${key}" (will retry in ${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - this.circuitOpenSince)) / 1000)}s)`,
      );
    }
    const body = {
      key,
      writtenAt: Date.now(),
      payload: obj,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const mem = new MemData(bytes);

    mem.merkleTree();

    let tx: unknown;
    let err: Error | null;
    try {
      [tx, err] = await this.indexer.upload(mem, this.rpcUrl, this.signer);
    } catch (e) {
      this.recordFailure();
      throw new OgStorageError(
        "INDEXER_UNREACHABLE",
        `indexer.upload threw: ${(e as Error)?.message ?? String(e)}`,
        e,
      );
    }
    if (err !== null) {
      this.recordFailure();
      throw new OgStorageError("UPLOAD_FAILED", `upload error: ${err.message}`, err);
    }

    if (isSingleUpload(tx)) {
      this.consecutiveFailures = 0;
      return {
        rootHash: tx.rootHash,
        txHash: tx.txHash,
        txSeq: tx.txSeq,
        byteLength: bytes.byteLength,
      };
    }
    this.recordFailure();
    throw new OgStorageError(
      "FRAGMENTED_UNEXPECTED",
      `upload returned fragmented result (${String((tx as { rootHashes?: string[] }).rootHashes?.length)} parts) — payload too large for single-chunk write`,
    );
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenSince = Date.now();
      console.warn(
        `[0g-storage] circuit OPEN after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — suppressing writes for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`,
      );
    }
  }
}

function isSingleUpload(tx: unknown): tx is { rootHash: string; txHash: string; txSeq: number } {
  if (tx === null || typeof tx !== "object") return false;
  const t = tx as Record<string, unknown>;
  return (
    typeof t["rootHash"] === "string" &&
    typeof t["txHash"] === "string" &&
    typeof t["txSeq"] === "number"
  );
}
