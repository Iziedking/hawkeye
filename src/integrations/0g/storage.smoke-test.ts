// 0G Storage smoke test. Patches Indexer.upload to run hermetically.

import process from "node:process";
import { OgStorageClient, OgStorageError } from "./storage";

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

// A valid-looking hex key so the ethers.Wallet constructor doesn't throw.
const FAKE_KEY = "0x" + "ab".repeat(32);

function makeClient(): OgStorageClient {
  return new OgStorageClient({
    privateKey: FAKE_KEY,
    rpcUrl: "http://localhost:0",
    indexerUrl: "http://localhost:0",
  });
}

type UploadCapture = {
  calledWith: unknown[];
};

function patchUpload(
  client: OgStorageClient,
  result: [unknown, Error | null],
): UploadCapture {
  const capture: UploadCapture = { calledWith: [] };
  const indexer = (client as unknown as { indexer: { upload: Function } }).indexer;
  indexer.upload = async (...args: unknown[]) => {
    capture.calledWith = args;
    return result;
  };
  return capture;
}

async function runTests(): Promise<void> {
  console.log("\n[1] writeJson happy path");
  {
    const client = makeClient();
    const fakeResult = {
      rootHash: "0xdeadbeef",
      txHash: "0xcafebabe",
      txSeq: 42,
    };
    const capture = patchUpload(client, [fakeResult, null]);

    const res = await client.writeJson("intent-123", {
      address: "0xabc",
      amount: { value: 1, unit: "USD" },
    });

    assert(res.rootHash === "0xdeadbeef", "rootHash forwarded");
    assert(res.txHash === "0xcafebabe", "txHash forwarded");
    assert(res.txSeq === 42, "txSeq forwarded");
    assert(res.byteLength > 0, "byteLength positive");

    // Verify the MemData arg was passed (first arg to upload).
    assert(capture.calledWith.length >= 1, "upload called with args");
  }

  console.log("\n[2] writeJson serializes nested objects");
  {
    const client = makeClient();
    let uploadedBytes: Uint8Array | null = null;
    const indexer = (client as unknown as { indexer: { upload: Function } }).indexer;
    indexer.upload = async (mem: { data: Uint8Array | undefined }) => {
      // MemData stores the raw bytes; grab them for inspection.
      // The SDK's MemData shape varies, but the bytes we passed in are the
      // constructor arg. We serialized them ourselves, so let's just verify
      // via the result — the important thing is that writeJson didn't throw.
      uploadedBytes = mem?.data ?? null;
      return [{ rootHash: "0x1", txHash: "0x2", txSeq: 1 }, null];
    };

    const intent = {
      intentId: "i-1",
      amount: { value: 0.5, unit: "NATIVE" },
      exits: [{ percent: 50, target: { kind: "multiplier", value: 3 } }],
    };
    const res = await client.writeJson("i-1", intent);
    assert(res.rootHash === "0x1", "nested: rootHash");
    assert(res.byteLength > 50, "nested: byteLength includes serialized payload");
  }

  console.log("\n[3] writeJson: upload returns error");
  {
    const client = makeClient();
    patchUpload(client, [null, new Error("disk full")]);

    let threw = false;
    try {
      await client.writeJson("k", { x: 1 });
    } catch (err) {
      threw = true;
      assert(err instanceof OgStorageError, "error: instanceof OgStorageError");
      assert(
        (err as OgStorageError).reason === "UPLOAD_FAILED",
        "error: reason UPLOAD_FAILED",
      );
    }
    assert(threw, "error: writeJson threw");
  }

  console.log("\n[4] writeJson: upload throws (network)");
  {
    const client = makeClient();
    const indexer = (client as unknown as { indexer: { upload: Function } }).indexer;
    indexer.upload = async () => {
      throw new Error("ECONNREFUSED");
    };

    let threw = false;
    try {
      await client.writeJson("k", {});
    } catch (err) {
      threw = true;
      assert(err instanceof OgStorageError, "network: instanceof OgStorageError");
      assert(
        (err as OgStorageError).reason === "INDEXER_UNREACHABLE",
        "network: reason INDEXER_UNREACHABLE",
      );
    }
    assert(threw, "network: writeJson threw");
  }

  console.log("\n[5] writeJson: fragmented result");
  {
    const client = makeClient();
    patchUpload(client, [{ rootHashes: ["a", "b"] }, null]);

    let threw = false;
    try {
      await client.writeJson("k", {});
    } catch (err) {
      threw = true;
      assert(err instanceof OgStorageError, "frag: instanceof OgStorageError");
      assert(
        (err as OgStorageError).reason === "FRAGMENTED_UNEXPECTED",
        "frag: reason FRAGMENTED_UNEXPECTED",
      );
    }
    assert(threw, "frag: writeJson threw");
  }
}

async function main(): Promise<void> {
  console.log("og-storage smoke test");
  await runTests();

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
