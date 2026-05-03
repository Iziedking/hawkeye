import Anthropic from "@anthropic-ai/sdk";
import { envOr } from "../../shared/env";
import type { OgInferenceRequest, OgInferenceResponse } from "../0g/compute";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export class ClaudeLlmClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? envOr("ANTHROPIC_API_KEY", "");
    if (!key) throw new Error("ANTHROPIC_API_KEY required for Claude fallback");
    this.client = new Anthropic({ apiKey: key });
    this.model = model ?? envOr("CLAUDE_MODEL", DEFAULT_MODEL);
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {}

  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      model: this.model,
      providerAddress: "anthropic-api",
      chatId: resp.id,
      verified: false,
    };
  }
}

type LlmLike = {
  infer: (r: OgInferenceRequest) => Promise<OgInferenceResponse>;
  ready: () => Promise<void>;
  close: () => Promise<void>;
};

export class FallbackLlmClient {
  private readonly primary: LlmLike | null;
  private readonly fallback: LlmLike | null;
  private primaryHealthy = true;
  private log: (msg: string) => void;

  get ogHealthy(): boolean {
    return this.primaryHealthy && this.primary !== null;
  }
  get usingFallback(): boolean {
    return !this.primaryHealthy && this.fallback !== null;
  }
  get fallbackName(): string | null {
    if (!this.usingFallback || !this.fallback) return null;
    return (this.fallback as { model?: string }).model ?? "fallback";
  }

  constructor(primary: LlmLike | null, fallback: LlmLike | null, log?: (msg: string) => void) {
    this.primary = primary;
    this.fallback = fallback;
    this.log = log ?? ((m) => console.log(`[llm] ${m}`));
  }

  async ready(): Promise<void> {
    if (this.fallback) await this.fallback.ready();
    if (this.primary) {
      try {
        await this.primary.ready();
        this.log("0G Compute ready (primary)");
      } catch {
        this.primaryHealthy = false;
        this.log("0G Compute unavailable" + (this.fallback ? ", fallback LLM is primary" : ""));
      }
    } else {
      this.primaryHealthy = false;
      this.log("No 0G client" + (this.fallback ? ", fallback LLM is primary" : ""));
    }
  }

  async close(): Promise<void> {
    if (this.primary) await this.primary.close();
    if (this.fallback) await this.fallback.close();
  }

  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    if (this.primaryHealthy && this.primary) {
      try {
        return await this.primary.infer(req);
      } catch (err) {
        this.log(`0G failed, falling back: ${(err as Error).message}`);
      }
    }
    if (this.fallback) {
      return this.fallback.infer(req);
    }
    throw new Error("No LLM available");
  }
}
