// Intent parser smoke test. Covers regex + LLM fallback without hitting 0G.

import process from "node:process";
import { parseIntent } from "./intent-parser.legacy";
import type {
  OgComputeClient,
  OgInferenceRequest,
  OgInferenceResponse,
} from "../integrations/0g/compute";
import { OgComputeError } from "../integrations/0g/compute";

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}


type FakeBehavior =
  | { kind: "text"; text: string }
  | { kind: "throw"; err: Error }
  | { kind: "hang"; ms: number };

class FakeLlm {
  readonly providerAddress = "0xfake";
  readonly model = "fake-model";
  calls: OgInferenceRequest[] = [];
  private behavior: FakeBehavior = { kind: "text", text: "null" };

  setNext(b: FakeBehavior): void {
    this.behavior = b;
  }

  async ready(): Promise<void> {
    /* no-op */
  }
  async close(): Promise<void> {
    /* no-op */
  }

  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    this.calls.push(req);
    const b = this.behavior;
    if (b.kind === "throw") throw b.err;
    if (b.kind === "hang") {
      await new Promise((r) => setTimeout(r, b.ms));
      return {
        text: "null",
        model: this.model,
        providerAddress: this.providerAddress,
        chatId: "chat-hang",
        verified: false,
      };
    }
    return {
      text: b.text,
      model: this.model,
      providerAddress: this.providerAddress,
      chatId: "chat-1",
      verified: true,
    };
  }
}

function asClient(f: FakeLlm): OgComputeClient {
  return f as unknown as OgComputeClient;
}


async function runRegexStage(): Promise<void> {
  console.log("\n[1] regex stage");

  const evm = await parseIntent({
    text: "ape now 0xAbCDef0123456789abcdef0123456789abcdef01",
    userId: "u-1",
    channel: "telegram",
  });
  assert(evm?.chain === "evm", "regex EVM: chain");
  assert(evm?.urgency === "INSTANT", "regex EVM: urgency INSTANT");

  const sol = await parseIntent({
    text: "careful on EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v please",
    userId: "u-2",
    channel: "whatsapp",
  });
  assert(sol?.chain === "solana", "regex Solana: chain");
  assert(sol?.urgency === "CAREFUL", "regex Solana: urgency CAREFUL");

  const native = await parseIntent({
    text: "buy 0.5 eth of 0xabcdef0123456789abcdef0123456789abcdef01",
    userId: "u-1",
    channel: "telegram",
  });
  assert(
    native?.amount.value === 0.5 && native?.amount.unit === "NATIVE",
    "regex: amount 0.5 NATIVE",
  );

  const dollar = await parseIntent({
    text: "throw $100 at 0xabcdef0123456789abcdef0123456789abcdef01",
    userId: "u-1",
    channel: "telegram",
  });
  assert(
    dollar?.amount.value === 100 && dollar?.amount.unit === "USD",
    "regex: amount $100 USD",
  );

  const defaultAmount = await parseIntent({
    text: "look at 0xabcdef0123456789abcdef0123456789abcdef01",
    userId: "u-1",
    channel: "telegram",
  });
  assert(
    defaultAmount?.amount.value === 0 && defaultAmount?.amount.unit === "NATIVE",
    "regex: missing amount defaults to 0/NATIVE",
  );

  // URL-embedded Solana-looking substring must NOT trigger a Solana match.
  const urlNoise = await parseIntent({
    text: "https://example.com/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    userId: "u-9",
    channel: "telegram",
  });
  assert(urlNoise === null, "regex: URL substring does not false-match Solana");
}


async function runLlmStage(): Promise<void> {
  console.log("\n[2] LLM fallback");

  // If no LLM is wired, regex miss -> null, no inference attempted.
  const noLlm = await parseIntent({
    text: "i really want to buy that new memecoin everyone is talking about",
    userId: "u-1",
    channel: "telegram",
  });
  assert(noLlm === null, "no llm dep: regex miss returns null");

  // "hi" is too short for the plausibility gate — must never hit the LLM.
  const fake0 = new FakeLlm();
  const hi = await parseIntent(
    { text: "hi", userId: "u-1", channel: "telegram" },
    { llm: asClient(fake0) },
  );
  assert(hi === null, "plausibility gate: short text returns null");
  assert(fake0.calls.length === 0, "plausibility gate: LLM not called");

  // Happy path: LLM returns strict JSON. Regex must find no address, so we
  // pick text that mentions an address in natural language only.
  const fake1 = new FakeLlm();
  fake1.setNext({
    kind: "text",
    text: JSON.stringify({
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: "evm",
      amount: { value: 25, unit: "USD" },
      urgency: "INSTANT",
    }),
  });
  const happy = await parseIntent(
    {
      text: "please fire twenty-five bucks into that new base memecoin asap",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake1) },
  );
  assert(happy?.chain === "evm", "llm happy: chain evm");
  assert(happy?.urgency === "INSTANT", "llm happy: urgency INSTANT");
  assert(
    happy?.amount.value === 25 && happy?.amount.unit === "USD",
    "llm happy: amount 25 USD",
  );
  assert(fake1.calls.length === 1, "llm happy: exactly one inference call");

  // Code-fenced JSON (some models ignore "no markdown" instructions).
  const fake2 = new FakeLlm();
  fake2.setNext({
    kind: "text",
    text:
      "```json\n" +
      JSON.stringify({
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        chain: "solana",
        amount: { value: 1, unit: "NATIVE" },
        urgency: "CAREFUL",
      }) +
      "\n```",
  });
  const fenced = await parseIntent(
    {
      text: "be careful about that usdc token everyone is shilling on twitter",
      userId: "u-2",
      channel: "whatsapp",
    },
    { llm: asClient(fake2) },
  );
  assert(fenced?.chain === "solana", "llm fenced: chain solana");
  assert(fenced?.urgency === "CAREFUL", "llm fenced: urgency CAREFUL");

  // Literal "null" response.
  const fake3 = new FakeLlm();
  fake3.setNext({ kind: "text", text: "null" });
  const nullResp = await parseIntent(
    {
      text: "what's the weather like in kuala lumpur right now",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake3) },
  );
  assert(nullResp === null, "llm: literal null -> null intent");

  // Malformed JSON -> null, no throw.
  const fake4 = new FakeLlm();
  fake4.setNext({ kind: "text", text: "sure thing boss, buying now!" });
  const logs: string[] = [];
  const malformed = await parseIntent(
    {
      text: "please extract something meaningful from this prose response",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake4), log: (m) => logs.push(m) },
  );
  assert(malformed === null, "llm malformed: returns null, no throw");
  assert(
    logs.some((m) => m.includes("not JSON")),
    "llm malformed: warning logged",
  );

  // LEDGER_LOW -> null, log notes ledger.
  const fake5 = new FakeLlm();
  fake5.setNext({
    kind: "throw",
    err: new OgComputeError("LEDGER_LOW", "not enough 0G"),
  });
  const logs5: string[] = [];
  const ledger = await parseIntent(
    {
      text: "please extract something meaningful from this prose response",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake5), log: (m) => logs5.push(m) },
  );
  assert(ledger === null, "llm LEDGER_LOW: returns null");
  assert(
    logs5.some((m) => m.toLowerCase().includes("ledger")),
    "llm LEDGER_LOW: ledger-flavored log",
  );

  // Timeout — llm hangs longer than the configured timeout.
  const fake6 = new FakeLlm();
  fake6.setNext({ kind: "hang", ms: 200 });
  const logs6: string[] = [];
  const timeout = await parseIntent(
    {
      text: "please extract something meaningful from this prose response",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake6), log: (m) => logs6.push(m), llmTimeoutMs: 25 },
  );
  assert(timeout === null, "llm timeout: returns null");
  assert(
    logs6.some((m) => m.toLowerCase().includes("failed")),
    "llm timeout: failure logged",
  );

  // Invalid LLM shape (wrong chain value) -> null.
  const fake7 = new FakeLlm();
  fake7.setNext({
    kind: "text",
    text: JSON.stringify({
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: "bitcoin",
      amount: { value: 1, unit: "NATIVE" },
      urgency: "NORMAL",
    }),
  });
  const badShape = await parseIntent(
    {
      text: "please extract something meaningful from this prose response",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake7) },
  );
  assert(badShape === null, "llm invalid chain: returns null");

  // EVM chain with non-hex address -> null (cross-check).
  const fake8 = new FakeLlm();
  fake8.setNext({
    kind: "text",
    text: JSON.stringify({
      address: "not-a-hex-address",
      chain: "evm",
      amount: { value: 1, unit: "NATIVE" },
      urgency: "NORMAL",
    }),
  });
  const badEvm = await parseIntent(
    {
      text: "please extract something meaningful from this prose response",
      userId: "u-1",
      channel: "telegram",
    },
    { llm: asClient(fake8) },
  );
  assert(badEvm === null, "llm invalid EVM address: returns null");
}

async function main(): Promise<void> {
  console.log("intent-parser smoke test");
  await runRegexStage();
  await runLlmStage();

  console.log();
  if (failures === 0) {
    console.log("ALL PASS");
    process.exit(0);
  } else {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
}

void main();
