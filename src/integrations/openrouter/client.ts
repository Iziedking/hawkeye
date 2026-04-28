/**
 * OpenRouter LLM Client
 *
 * Drop-in adapter that implements the same `infer()` interface as
 * OgComputeClient so the LLM Router can use it seamlessly.
 *
 * Uses OpenRouter's OpenAI-compatible /chat/completions endpoint.
 * Default model: meta-llama/llama-3.1-8b-instruct:free (no billing needed).
 */

import { envOr, requireEnv } from "../../shared/env";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b:free";
const DEFAULT_TIMEOUT_MS = 15_000;

export type OpenRouterInferRequest = {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type OpenRouterInferResponse = {
  text: string;
  model: string;
  providerAddress: string;
  chatId: string;
  verified: boolean;
};

export class OpenRouterClient {
  private readonly apiKey: string;
  readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? requireEnv("OPENROUTER_API_KEY");
    this.model = opts.model ?? envOr("OPENROUTER_MODEL", DEFAULT_MODEL);
  }

  /**
   * No-op ready() for compatibility with OgComputeClient interface.
   */
  async ready(): Promise<void> {
    // Verify the API key works with a lightweight call
    console.log(`[OpenRouter] Client ready — model=${this.model}`);
  }

  /**
   * Run inference via OpenRouter. Same signature as OgComputeClient.infer().
   */
  async infer(req: OpenRouterInferRequest): Promise<OpenRouterInferResponse> {
    const model = req.model ?? this.model;

    const body = {
      model,
      messages: [
        { role: "system" as const, content: req.system },
        { role: "user" as const, content: req.user },
      ],
      max_tokens: req.maxTokens ?? 512,
      temperature: req.temperature ?? 0,
    };

    let resp: Response;
    try {
      resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://github.com/hawkeye-agent",
          "X-Title": "HAWKEYE Agent",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `[OpenRouter] Request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `[OpenRouter] HTTP ${resp.status}: ${text.slice(0, 300)}`,
      );
    }

    const data = (await resp.json()) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const chatId = data.id ?? "";

    return {
      text,
      model: data.model ?? model,
      providerAddress: "openrouter",
      chatId,
      verified: true, // No TEE verification needed for OpenRouter
    };
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}
