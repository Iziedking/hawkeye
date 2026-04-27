
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import { envOr, requireEnv } from "../../shared/env";

const DEFAULT_RPC_URL = "https://evmrpc-testnet.0g.ai";

const DEFAULT_PROVIDER_ADDRESS = "0xa48f01287233509FD694a22Bf840225062E67836";
const DEFAULT_MODEL = "qwen/qwen-2.5-7b-instruct";


const MIN_LEDGER_OG = 3;
const MIN_PROVIDER_FUND_OG = 1;

export type OgInferenceRequest = {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type OgInferenceResponse = {
  text: string;
  model: string;
  providerAddress: string;
  chatId: string;
  verified: boolean;
};

export type OgComputeErrorReason =
  | "LEDGER_LOW"
  | "PROVIDER_UNREACHABLE"
  | "VERIFICATION_FAILED"
  | "UNKNOWN";

export class OgComputeError extends Error {
  readonly reason: OgComputeErrorReason;
  constructor(reason: OgComputeErrorReason, message: string, cause?: unknown) {
    super(message);
    this.name = "OgComputeError";
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}


type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export type OgComputeClientOptions = {
  privateKey?: string;
  rpcUrl?: string;
  providerAddress?: string;
  model?: string;
};

export class OgComputeClient {
  private readonly wallet: ethers.Wallet;
  readonly providerAddress: string;
  readonly model: string;

  private brokerPromise: Promise<Broker> | null = null;
  private serviceMetaPromise: Promise<{ endpoint: string; model: string }> | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(opts: OgComputeClientOptions = {}) {
    const privateKey = opts.privateKey ?? requireEnv("HAWKEYE_EVM_PRIVATE_KEY");
    const rpcUrl = opts.rpcUrl ?? envOr("OG_RPC_URL", DEFAULT_RPC_URL);
    this.providerAddress =
      opts.providerAddress ?? envOr("OG_PROVIDER_ADDRESS", DEFAULT_PROVIDER_ADDRESS);
    this.model = opts.model ?? envOr("OG_MODEL", DEFAULT_MODEL);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  private async getBroker(): Promise<Broker> {
    if (this.brokerPromise === null) {
      this.brokerPromise = createZGComputeNetworkBroker(this.wallet);
    }
    return this.brokerPromise;
  }


  async ready(): Promise<void> {
    if (this.readyPromise === null) {
      this.readyPromise = this.doReady().catch((err) => {
        this.readyPromise = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async doReady(): Promise<void> {
    const broker = await this.getBroker();


    try {
      await broker.ledger.addLedger(MIN_LEDGER_OG);
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        try {
          await broker.ledger.depositFund(MIN_LEDGER_OG);
        } catch (depErr) {
          if (!isAlreadyExistsError(depErr)) {
            throw classify(depErr, "LEDGER_LOW", "depositFund failed");
          }
        }
      } else {
        throw classify(err, "LEDGER_LOW", "addLedger failed");
      }
    }


    try {
      await broker.inference.acknowledgeProviderSigner(this.providerAddress);
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw classify(err, "PROVIDER_UNREACHABLE", "acknowledgeProviderSigner failed");
      }
    }


    try {
      await broker.ledger.transferFund(
        this.providerAddress,
        "inference",
        ethers.parseEther(String(MIN_PROVIDER_FUND_OG)),
      );
    } catch (err) {

      if (!isAlreadyExistsError(err)) {
        throw classify(err, "LEDGER_LOW", "transferFund failed");
      }
    }
  }

  private async getServiceMeta(): Promise<{ endpoint: string; model: string }> {
    if (this.serviceMetaPromise === null) {
      this.serviceMetaPromise = this.getBroker().then((b) =>
        b.inference.getServiceMetadata(this.providerAddress),
      );
    }
    return this.serviceMetaPromise;
  }


  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    await this.ready();
    const broker = await this.getBroker();
    const meta = await this.getServiceMeta();
    const model = req.model ?? this.model ?? meta.model;


    let headers: Record<string, string | undefined>;
    try {
      headers = (await broker.inference.getRequestHeaders(
        this.providerAddress,
      )) as unknown as Record<string, string | undefined>;
    } catch (err) {
      throw classify(err, "PROVIDER_UNREACHABLE", "getRequestHeaders failed");
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
    if (req.temperature !== undefined) body["temperature"] = req.temperature;

    const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") fetchHeaders[k] = v;
    }

    let resp: Response;
    try {
      resp = await fetch(`${meta.endpoint}/chat/completions`, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw classify(err, "PROVIDER_UNREACHABLE", "fetch to provider failed");
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new OgComputeError(
        "PROVIDER_UNREACHABLE",
        `provider returned ${resp.status}: ${text.slice(0, 200)}`,
      );
    }

    const completion = (await resp.json()) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const chatId = completion.id ?? "";
    const text = completion.choices?.[0]?.message?.content ?? "";


    // processResponse may throw on testnet (no TEE receipts), treat as unverified
    let verified: boolean;
    try {
      const v = await broker.inference.processResponse(this.providerAddress, chatId, text);
      verified = v === true;
    } catch {
      verified = false;
    }

    return {
      text,
      model,
      providerAddress: this.providerAddress,
      chatId,
      verified,
    };
  }


  async close(): Promise<void> {

  }
}

function isAlreadyExistsError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return (
    msg.includes("already exist") ||
    msg.includes("already acknowledged") ||
    msg.includes("already registered") ||
    msg.includes("execution reverted")
  );
}

function classify(
  err: unknown,
  reason: OgComputeErrorReason,
  label: string,
): OgComputeError {
  const msg = (err as Error)?.message ?? String(err);
  const lowered = msg.toLowerCase();
  if (lowered.includes("insufficient") || lowered.includes("balance")) {
    return new OgComputeError("LEDGER_LOW", `${label}: ${msg}`, err);
  }
  if (lowered.includes("network") || lowered.includes("timeout") || lowered.includes("econnrefused")) {
    return new OgComputeError("PROVIDER_UNREACHABLE", `${label}: ${msg}`, err);
  }
  return new OgComputeError(reason, `${label}: ${msg}`, err);
}
