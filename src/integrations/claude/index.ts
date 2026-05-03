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

/**
 * Two-tier LLM client.
 *
 * Once the primary (0G Compute) fails for any request, we mark it unhealthy
 * and route every subsequent call directly to the fallback for the next
 * `REPROBE_TTL_MS`. After that window the next request gets one re-probe of
 * 0G — if it works, we return to using it as primary; if not, we suppress
 * for another window. This means a single 0G outage costs at most one extra
 * timeout, not one per inference call.
 */
const REPROBE_TTL_MS = 5 * 60 * 1_000;

export class FallbackLlmClient {
  private readonly primary: LlmLike | null;
  private readonly fallback: LlmLike | null;
  private primaryHealthy = true;
  private suppressedUntil = 0;
  private log: (msg: string) => void;

  get ogHealthy(): boolean {
    return this.primaryHealthy && this.primary !== null && Date.now() >= this.suppressedUntil;
  }
  get usingFallback(): boolean {
    return !this.ogHealthy && this.fallback !== null;
  }
  get fallbackName(): string | null {
    if (!this.fallback) return null;
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
        this.markPrimaryUnhealthy("ready() failed");
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
    const shouldTryPrimary = this.primary !== null && Date.now() >= this.suppressedUntil;

    if (shouldTryPrimary) {
      try {
        const resp = await this.primary!.infer(req);
        if (!this.primaryHealthy) {
          this.primaryHealthy = true;
          this.log("0G Compute recovered, primary path restored");
        }
        return resp;
      } catch (err) {
        this.markPrimaryUnhealthy((err as Error).message);
      }
    }

    if (this.fallback) {
      return this.fallback.infer(req);
    }
    throw new Error("No LLM available");
  }

  /**
   * Test hook + Telegram /llm command surface.
   */
  resetPrimary(): void {
    this.primaryHealthy = true;
    this.suppressedUntil = 0;
    this.log("0G Compute primary state reset; next call will re-probe");
  }

  private markPrimaryUnhealthy(reason: string): void {
    this.primaryHealthy = false;
    this.suppressedUntil = Date.now() + REPROBE_TTL_MS;
    const fallbackTag = this.fallback ? ` — fallback LLM active for ${REPROBE_TTL_MS / 1000}s` : "";
    this.log(`0G Compute unavailable: ${reason.slice(0, 120)}${fallbackTag}`);
  }
}
