import { envOr } from "../../shared/env";

const DEFAULT_BASE_URL = "https://app.keeperhub.com/api";

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

const CHAIN_TO_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  137: "polygon",
  42161: "arbitrum",
  10: "optimism",
  56: "bsc",
  43114: "avalanche",
  11155111: "sepolia",
};

export type ExecutionStatus = {
  executionId: string;
  status: "pending" | "running" | "completed" | "failed";
  txHash?: string;
  gasUsedWei?: string;
  createdAt?: string;
  completedAt?: string;
};

export type ContractCallParams = {
  contractAddress: string;
  network: string;
  functionName: string;
  functionArgs?: string;
  abi?: string;
  value?: string;
  gasLimitMultiplier?: number;
};

export type TransferParams = {
  network: string;
  recipientAddress: string;
  amount: string;
  tokenAddress?: string;
};

export type KeeperHubErrorReason =
  | "NO_API_KEY"
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.circuitOpen) {
      throw new KeeperHubError("CIRCUIT_OPEN", "KeeperHub circuit breaker open");
    }

    try {
      const opts: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };
      if (body !== undefined) opts.body = JSON.stringify(body);

      const resp = await fetch(`${this.baseUrl}${path}`, opts);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        this.recordFailure();
        throw new KeeperHubError(
          "SUBMISSION_FAILED",
          `KeeperHub ${resp.status}: ${text.slice(0, 200)}`,
        );
      }

      this.consecutiveFailures = 0;
      const data = (await resp.json()) as { data?: T };
      return (data.data ?? data) as T;
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

  async checkReachable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/workflows`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok || resp.status === 401 || resp.status === 403;
    } catch {
      this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD;
      this.circuitOpenSince = Date.now();
      console.warn("[keeperhub] unreachable at startup — circuit OPEN");
      return false;
    }
  }

  async fetchWalletAddress(): Promise<string | null> {
    try {
      const resp = await fetch(`${this.baseUrl.replace("/api", "")}/api/user/wallet`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { address?: string };
      return data.address ?? null;
    } catch {
      return null;
    }
  }

  networkFromChainId(chainId: number): string {
    return CHAIN_TO_NETWORK[chainId] ?? "ethereum";
  }

  async contractCall(params: ContractCallParams): Promise<ExecutionStatus> {
    const result = await this.request<{
      executionId?: string;
      status?: string;
      transactionHash?: string;
    }>("POST", "/execute/contract-call", params);

    return {
      executionId: result.executionId ?? `kh-${Date.now()}`,
      status: (result.status as ExecutionStatus["status"]) ?? "pending",
      ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
    };
  }

  async transfer(params: TransferParams): Promise<ExecutionStatus> {
    const result = await this.request<{
      executionId?: string;
      status?: string;
      transactionHash?: string;
    }>("POST", "/execute/transfer", params);

    return {
      executionId: result.executionId ?? `kh-${Date.now()}`,
      status: (result.status as ExecutionStatus["status"]) ?? "pending",
      ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
    };
  }

  async getExecutionStatus(executionId: string): Promise<ExecutionStatus> {
    const result = await this.request<{
      executionId?: string;
      status?: string;
      transactionHash?: string;
      gasUsedWei?: string;
      createdAt?: string;
      completedAt?: string;
    }>("GET", `/execute/${executionId}/status`);

    const st: ExecutionStatus = {
      executionId: result.executionId ?? executionId,
      status: (result.status as ExecutionStatus["status"]) ?? "pending",
    };
    if (result.transactionHash !== undefined) st.txHash = result.transactionHash;
    if (result.gasUsedWei !== undefined) st.gasUsedWei = result.gasUsedWei;
    if (result.createdAt !== undefined) st.createdAt = result.createdAt;
    if (result.completedAt !== undefined) st.completedAt = result.completedAt;
    return st;
  }

  async executeAndWait(params: ContractCallParams, maxWaitMs = 30_000): Promise<ExecutionStatus> {
    const exec = await this.contractCall(params);
    console.log(`[keeperhub] execution started: ${exec.executionId}`);

    if (exec.status === "completed" || exec.status === "failed") return exec;

    const start = Date.now();
    const pollInterval = 2_000;

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const status = await this.getExecutionStatus(exec.executionId);
        if (status.status === "completed" || status.status === "failed") {
          return status;
        }
      } catch {
        // status poll failure is transient
      }
    }

    return exec;
  }

  // Legacy compat: the execution agent calls submitAndWait(signedTx, chainId).
  // KeeperHub's actual API doesn't accept pre-signed txs, so this is a no-op
  // that forces the fallback to Privy direct submission.
  async submitAndWait(
    _signedTx: string,
    _chainId: number,
  ): Promise<{ bundleId: string; status: "failed"; txHash?: string }> {
    return { bundleId: `kh-unsupported`, status: "failed" };
  }
}
