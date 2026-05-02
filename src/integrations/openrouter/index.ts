import { envOr } from "../../shared/env";
import type { OgInferenceRequest, OgInferenceResponse } from "../0g/compute";

const DEFAULT_MODEL = "google/gemini-2.0-flash-001";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterClient {
  private readonly apiKey: string;
  readonly model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? envOr("OPENROUTER_API_KEY", "");
    if (!key) throw new Error("OPENROUTER_API_KEY required for LLM fallback");
    this.apiKey = key;
    this.model = model ?? envOr("OPENROUTER_MODEL", DEFAULT_MODEL);
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {}

  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      messages: [
        { role: "system" as const, content: req.system },
        { role: "user" as const, content: req.user },
      ],
    };

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/hawkeye-bot",
        "X-Title": "HAWKEYE",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const text = data.choices?.[0]?.message?.content ?? "";

    return {
      text,
      model: data.model ?? this.model,
      providerAddress: "openrouter",
      chatId: data.id ?? "",
      verified: false,
    };
  }
}
