import { test } from "node:test";
import assert from "node:assert/strict";
delete process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID;
test("V4 Ethereum defaults to querying by subgraph ID", async () => {
  const cfg = await import("../../build/v4Config.js");
  const v4 = await import("../../build/v4Subgraph.js");
  assert.deepEqual(cfg.V4_ETHEREUM_TARGET, { kind: "subgraph", id: "2Gu5HCAnWrNk2pXidscdhNEQhrwLgMKmssuCe9JhZhAe" });
  assert.equal(v4.V4_NETWORKS.ethereum.kind, "subgraph");
});
