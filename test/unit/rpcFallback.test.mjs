import { test } from "node:test";
import assert from "node:assert/strict";

const rpc = await import("../../build/rpcClient.js");

test("ethereum has at least two public fallbacks", () => {
  assert.ok(rpc.PUBLIC_FALLBACKS.ethereum.length >= 2);
  for (const key of ["base", "arbitrum", "polygon", "optimism", "avalanche"]) {
    assert.ok(rpc.PUBLIC_FALLBACKS[key].length >= 2, key);
  }
});

test("a dedicated ETHEREUM_RPC_URL is the first transport", () => {
  const previous = process.env.ETHEREUM_RPC_URL;
  process.env.ETHEREUM_RPC_URL = "https://example.test/ethereum";
  try {
    rpc.clearRpcClient("ethereum");
    const plan = rpc.rpcUrlPlan("ethereum");
    assert.equal(plan[0], "https://example.test/ethereum");
    assert.ok(plan.length >= 3);
    assert.equal(new Set(plan).size, plan.length);
  } finally {
    if (previous === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = previous;
    rpc.clearRpcClient("ethereum");
  }
});

test("withRpcRetry drops the cached client after a 429 and then succeeds", async () => {
  const previous = process.env.RPC_RETRY_BASE_MS;
  process.env.RPC_RETRY_BASE_MS = "1";
  rpc.clearRpcClient("ethereum");
  rpc.rpcClient("ethereum");
  assert.equal(rpc.hasCachedRpcClient("ethereum"), true);
  let calls = 0;
  try {
    const result = await rpc.withRpcRetry("ethereum", async () => {
      calls += 1;
      if (calls === 1) throw new Error("429 rate limit");
      assert.equal(rpc.hasCachedRpcClient("ethereum"), false);
      return "ok";
    }, 2);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.RPC_RETRY_BASE_MS;
    else process.env.RPC_RETRY_BASE_MS = previous;
    rpc.clearRpcClient("ethereum");
  }
});

test("a non-retryable error is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    rpc.withRpcRetry("base", async () => {
      calls += 1;
      throw new Error("execution reverted");
    }, 3),
    /execution reverted/
  );
  assert.equal(calls, 1);
});
