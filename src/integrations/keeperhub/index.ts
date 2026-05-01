import { envOr } from "../../shared/env";

const DEFAULT_BASE_URL = "https://api.keeperhub.com";

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type TxParams = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  from: string;
  gasLimit?: string;
};

export type SimulationResult = {
  success: boolean;
  gasEstimate?: number;
  revertReason?: string;
  simulatedAt: number;
};

export type BundleResult = {
  bundleId: string;
  txHash?: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  submittedAt: number;
};

export type BundleStatus = {
  bundleId: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash?: string;
  blockNumber?: number;
  gasUsed?: number;
};

export type KeeperHubErrorReason =
  | "NO_API_KEY"
  | "SIMULATION_FAILED"
  | "SUBMISSION_FAILED"
  | "TIMEOUT"
  | "CIRCUIT_OPEN"
  | "UNKNOWN";

export class KeeperHubError extends Error {
  readonly reason: KeeperHubErrorReason;
  constructor(reason: KeeperHubErrorReason, message: string) {
    super(message);
    this.name = "KeeperHubError";
    this.reason = reason;
  }
}

export class KeeperHubClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private consecutiveFailures = 0;
  private circuitOpenSince = 0;

  constructor(opts: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey ?? envOr("KH_API_KEY", "");
    this.baseUrl = opts.baseUrl ?? envOr("KH_BASE_URL", DEFAULT_BASE_URL);

    if (!this.apiKey) {
      throw new KeeperHubError("NO_API_KEY", "KH_API_KEY required for KeeperHub integration");
    }
  }

  get circuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    const elapsed = Date.now() - this.circuitOpenSince;
    if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      this.consecutiveFailures = 0;
      this.circuitOpenSince = 0;
      console.log("[keeperhub] circuit half-open — retrying");
      return false;
    }
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenSince = Date.now();
      console.warn(
        `[keeperhub] circuit OPEN after ${CIRCUIT_BREAKER_THRESHOLD} failures — fallback to direct for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`,
      );
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (this.circuitOpen) {
      throw new KeeperHubError("CIRCUIT_OPEN", "KeeperHub circuit breaker open");
    }

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        this.recordFailure();
        throw new KeeperHubError(
          "SUBMISSION_FAILED",
          `KeeperHub ${resp.status}: ${text.slice(0, 200)}`,
        );
      }

      this.consecutiveFailures = 0;
      return (await resp.json()) as T;
    } catch (err) {
      if (err instanceof KeeperHubError) throw err;
      this.recordFailure();
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("timeout") || msg.includes("abort")) {
        throw new KeeperHubError("TIMEOUT", `KeeperHub request timed out: ${msg}`);
      }
      throw new KeeperHubError("UNKNOWN", `KeeperHub error: ${msg}`);
    }
  }

  async simulateTx(tx: TxParams): Promise<SimulationResult> {
    try {
      const result = await this.post<{
        success?: boolean;
        gas_estimate?: number;
        revert_reason?: string;
      }>("/v1/simulate", {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chain_id: tx.chainId,
        gas_limit: tx.gasLimit,
      });

      const sim: SimulationResult = {
        success: result.success !== false,
        simulatedAt: Date.now(),
      };
      if (result.gas_estimate !== undefined) sim.gasEstimate = result.gas_estimate;
      if (result.revert_reason !== undefined) sim.revertReason = result.revert_reason;
      return sim;
    } catch (err) {
      if (err instanceof KeeperHubError) throw err;
      throw new KeeperHubError("SIMULATION_FAILED", (err as Error).message);
    }
  }

  async submitBundle(signedTx: string, chainId: number): Promise<BundleResult> {
    const result = await this.post<{
      bundle_id?: string;
      tx_hash?: string;
      status?: string;
    }>("/v1/bundle", {
      signed_transaction: signedTx,
      chain_id: chainId,
      preferences: {
        privacy: true,
        fast: true,
      },
    });

    const bundle: BundleResult = {
      bundleId: result.bundle_id ?? `kh-${Date.now()}`,
      status: (result.status as BundleResult["status"]) ?? "pending",
      submittedAt: Date.now(),
    };
    if (result.tx_hash !== undefined) bundle.txHash = result.tx_hash;
    return bundle;
  }

  async getStatus(bundleId: string): Promise<BundleStatus> {
    const result = await this.post<{
      bundle_id?: string;
      status?: string;
      tx_hash?: string;
      block_number?: number;
      gas_used?: number;
    }>("/v1/bundle/status", { bundle_id: bundleId });

    const st: BundleStatus = {
      bundleId: result.bundle_id ?? bundleId,
      status: (result.status as BundleStatus["status"]) ?? "pending",
    };
    if (result.tx_hash !== undefined) st.txHash = result.tx_hash;
    if (result.block_number !== undefined) st.blockNumber = result.block_number;
    if (result.gas_used !== undefined) st.gasUsed = result.gas_used;
    return st;
  }

  async submitAndWait(
    signedTx: string,
    chainId: number,
    maxWaitMs = 30_000,
  ): Promise<BundleStatus> {
    const bundle = await this.submitBundle(signedTx, chainId);
    console.log(`[keeperhub] bundle submitted: ${bundle.bundleId}`);

    const start = Date.now();
    const pollInterval = 2_000;

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const status = await this.getStatus(bundle.bundleId);
        if (status.status === "confirmed" || status.status === "failed") {
          return status;
        }
      } catch {
        // status poll failure is transient
      }
    }

    const fallback: BundleStatus = {
      bundleId: bundle.bundleId,
      status: bundle.txHash ? "submitted" : "pending",
    };
    if (bundle.txHash !== undefined) fallback.txHash = bundle.txHash;
    return fallback;
  }
}
