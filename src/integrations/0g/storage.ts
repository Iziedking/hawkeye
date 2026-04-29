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

export class OgStorageClient {
  private readonly signer: ethers.Wallet;
  private readonly indexer: Indexer;
  private readonly rpcUrl: string;

  constructor(opts: OgStorageClientOptions = {}) {
    const privateKey = opts.privateKey ?? requireEnv("HAWKEYE_EVM_PRIVATE_KEY");
    this.rpcUrl = opts.rpcUrl ?? envOr("OG_RPC_URL", DEFAULT_RPC_URL);
    const indexerUrl = opts.indexerUrl ?? envOr("OG_INDEXER_URL", DEFAULT_INDEXER_URL);

    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, provider);
    this.indexer = new Indexer(indexerUrl);
  }

  async writeJson(key: string, obj: unknown): Promise<OgStorageWriteResult> {
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
      throw new OgStorageError(
        "INDEXER_UNREACHABLE",
        `indexer.upload threw: ${(e as Error)?.message ?? String(e)}`,
        e,
      );
    }
    if (err !== null) {
      throw new OgStorageError("UPLOAD_FAILED", `upload error: ${err.message}`, err);
    }

    if (isSingleUpload(tx)) {
      return {
        rootHash: tx.rootHash,
        txHash: tx.txHash,
        txSeq: tx.txSeq,
        byteLength: bytes.byteLength,
      };
    }
    throw new OgStorageError(
      "FRAGMENTED_UNEXPECTED",
      `upload returned fragmented result (${String((tx as { rootHashes?: string[] }).rootHashes?.length)} parts) — payload too large for single-chunk write`,
    );
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
