import process from "node:process";
import { routeMessage } from "./llm-router";
import type { RouterDeps, RouterInput } from "./llm-router";
import type {
  OgComputeClient,
  OgInferenceRequest,
  OgInferenceResponse,
} from "../integrations/0g/compute";
import { OgComputeError } from "../integrations/0g/compute";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    fail++;
  }
}

function input(text: string): RouterInput {
  return { text, userId: "user1", channel: "telegram" };
}

type FakeResponse = {
  text: string;
};

class FakeLlm {
  calls: OgInferenceRequest[] = [];
  private response: FakeResponse | Error;

  constructor(response: FakeResponse | Error) {
    this.response = response;
  }

  async infer(req: OgInferenceRequest): Promise<OgInferenceResponse> {
    this.calls.push(req);
    if (this.response instanceof Error) throw this.response;
    return {
      text: this.response.text,
      model: "test",
      providerAddress: "0x0",
      chatId: "test-req",
      verified: true,
    };
  }

  async ready(): Promise<void> { }
  async close(): Promise<void> { }
}

async function main(): Promise<void> {
  console.log("llm-router smoke test\n");

  // === [1] Degen shortcut (no LLM call) ===
  console.log("[1] degen shortcut — no LLM call");
  {
    const llm = new FakeLlm({ text: "should not be called" });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r1 = await routeMessage(input("0x6982508145454Ce325dDbE47a25d4ec3d2311933"), deps);
    assert(r1.category === "DEGEN_SNIPE", "bare EVM address → DEGEN_SNIPE");
    assert(
      r1.data["address"] === "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
      "address extracted",
    );
    assert(r1.data["chain"] === "evm", "chain = evm");
    assert(r1.data["urgency"] === "INSTANT", "default urgency = INSTANT");
    assert(r1.confidence === 1.0, "confidence = 1.0");
    assert(llm.calls.length === 0, "LLM not called for bare address");
  }

  {
    const llm = new FakeLlm({ text: "should not be called" });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r2 = await routeMessage(input("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), deps);
    assert(r2.category === "DEGEN_SNIPE", "bare SOL address → DEGEN_SNIPE");
    assert(r2.data["chain"] === "solana", "chain = solana");
    assert(llm.calls.length === 0, "LLM not called for SOL address");
  }

  {
    const llm = new FakeLlm({ text: "should not be called" });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r3 = await routeMessage(input("ape 0x6982508145454Ce325dDbE47a25d4ec3d2311933"), deps);
    assert(r3.category === "DEGEN_SNIPE", '"ape" + EVM → DEGEN_SNIPE');
    assert(r3.data["urgency"] === "INSTANT", '"ape" triggers INSTANT');
    assert(llm.calls.length === 0, "LLM not called for degen keyword + address");
  }

  {
    const llm = new FakeLlm({ text: "should not be called" });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r4 = await routeMessage(
      input("buy 0.5 eth 0x6982508145454Ce325dDbE47a25d4ec3d2311933"),
      deps,
    );
    assert(r4.category === "DEGEN_SNIPE", '"buy 0.5 eth" + address → DEGEN_SNIPE');
    assert(
      r4.data["amount"] !== null && (r4.data["amount"] as Record<string, unknown>)["value"] === 0.5,
      "amount 0.5 extracted",
    );
    assert(llm.calls.length === 0, "LLM not called for amount + address");
  }

  // === [2] LLM classification ===
  console.log("\n[2] LLM classification");
  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "RESEARCH_TOKEN",
        confidence: 0.9,
        data: {
          address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
          tokenName: null,
          chain: "evm",
          question: "is this safe?",
        },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(
      input("is 0x6982508145454Ce325dDbE47a25d4ec3d2311933 safe? I want to check before buying"),
      deps,
    );
    assert(r.category === "RESEARCH_TOKEN", "address + question → RESEARCH_TOKEN (via LLM)");
    assert(llm.calls.length === 1, "LLM was called for question with address");
  }

  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "BRIDGE",
        confidence: 0.95,
        data: {
          amount: { value: 0.5, unit: "NATIVE" },
          fromChain: "ethereum",
          toChain: "base",
          asset: "ETH",
        },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("bridge 0.5 ETH to Base"), deps);
    assert(r.category === "BRIDGE", '"bridge 0.5 ETH to Base" → BRIDGE');
    assert(llm.calls.length === 1, "LLM called for bridge intent");
  }

  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "GENERAL_QUERY",
        confidence: 0.85,
        data: { query: "what's trending in crypto right now?" },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("what's trending?"), deps);
    assert(r.category === "GENERAL_QUERY", '"what\'s trending?" → GENERAL_QUERY');
  }

  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "SETTINGS",
        confidence: 0.9,
        data: { setting: "mode", value: "degen" },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("set degen mode"), deps);
    assert(r.category === "SETTINGS", '"set degen mode" → SETTINGS');
  }

  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "TRADE",
        confidence: 0.9,
        data: {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          chain: "evm",
          side: "buy",
          amount: { value: 100, unit: "USD" },
          urgency: "NORMAL",
        },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(
      input(
        "I want to purchase exactly 100 USDC worth of the USDC token on ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ),
      deps,
    );
    assert(r.category === "TRADE", "explicit trade with params → TRADE");
    assert(
      r.data["address"] === "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "trade address extracted",
    );
  }

  // === [3] Edge cases ===
  console.log("\n[3] edge cases");
  {
    const r = await routeMessage(input(""), {});
    assert(r.category === "UNKNOWN", "empty string → UNKNOWN");
    assert(r.confidence === 1.0, "empty string confidence = 1.0");
  }

  {
    const llm = new FakeLlm(new Error("timeout after 8000ms"));
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("tell me about the latest defi trends"), deps);
    assert(r.category === "GENERAL_QUERY", "LLM timeout → regex fallback → GENERAL_QUERY");
    assert(r.confidence === 0.3, "fallback confidence = 0.3");
  }

  {
    const llm = new FakeLlm(new OgComputeError("LEDGER_LOW", "insufficient funds"));
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("what's the best arbitrage opportunity right now?"), deps);
    assert(r.category === "GENERAL_QUERY", "LEDGER_LOW → regex fallback → GENERAL_QUERY");
  }

  {
    const llm = new FakeLlm({ text: "this is not json at all" });
    const logs: string[] = [];
    const deps: RouterDeps = {
      llm: llm as unknown as OgComputeClient,
      log: (m) => logs.push(m),
    };

    const r = await routeMessage(input("some random message that produces bad json"), deps);
    assert(r.category === "UNKNOWN", "malformed JSON → UNKNOWN");
    assert(
      logs.some((l) => l.includes("not JSON")),
      "malformed JSON logged",
    );
  }

  {
    const deps: RouterDeps = {};
    const r = await routeMessage(input("0x6982508145454Ce325dDbE47a25d4ec3d2311933"), deps);
    assert(r.category === "DEGEN_SNIPE", "no LLM dep + address → DEGEN_SNIPE via shortcut");
  }

  {
    const deps: RouterDeps = {};
    const r = await routeMessage(input("hello how are you"), deps);
    assert(r.category === "GENERAL_QUERY", "no LLM dep + no address → GENERAL_QUERY fallback");
  }

  {
    const llm = new FakeLlm({
      text: JSON.stringify({
        category: "DEGEN_SNIPE",
        confidence: 0.15,
        data: { address: null, chain: null },
      }),
    });
    const deps: RouterDeps = { llm: llm as unknown as OgComputeClient };

    const r = await routeMessage(input("maybe buy something idk"), deps);
    assert(r.category === "UNKNOWN", "low confidence (<0.3) → UNKNOWN");
  }

  console.log(`\n${pass + fail} assertions: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.error("\nSOME TESTS FAILED");
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
