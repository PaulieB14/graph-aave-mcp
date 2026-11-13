import { test, after } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const original = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  calls.push(JSON.parse(init.body));
  return new Response(JSON.stringify({
    data: { hubs: [], spokes: [], reserves: [], activities: { items: [], pageInfo: {} } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const api = await import("../../build/aaveV4Api.js");

test("getV4Hubs defaults to Ethereum and Base", async () => {
  calls.length = 0;
  await api.getV4Hubs();
  assert.match(calls[0].query, /chainIds: \[1, 8453\]/);
  await api.getV4Hubs(8453);
  assert.match(calls[1].query, /chainIds: \[8453\]/);
  assert.doesNotMatch(calls[1].query, /8453, 1|1, 8453/);
});

test("getV4Spokes and getV4Reserves use the same default", async () => {
  calls.length = 0;
  await api.getV4Spokes();
  await api.getV4Reserves();
  assert.match(calls[0].query, /chainIds: \[1, 8453\]/);
  assert.match(calls[1].query, /chainIds: \[1, 8453\]/);
});

test("user reads default to Ethereum and Base", async () => {
  calls.length = 0;
  const user = "0x0000000000000000000000000000000000000001";
  await api.getV4UserSupplies(user);
  await api.getV4UserBorrows(user);
  await api.getV4UserBalances(user);
  await api.getV4UserPositions(user);
  for (const call of calls) {
    assert.deepEqual(findChainIds(call), [1, 8453]);
  }
});

test("getV4UserActivities defaults to every type including BORROW_SWAP", async () => {
  calls.length = 0;
  await api.getV4UserActivities("0x0000000000000000000000000000000000000001");
  const types = calls[0].variables.request.types;
  for (const required of ["SUPPLY", "BORROW", "REPAY", "WITHDRAW", "LIQUIDATED", "BORROW_SWAP", "LEVERAGE", "SUPPLY_SWAP"]) {
    assert.ok(types.includes(required), required);
  }
  assert.deepEqual(calls[0].variables.request.query.chainIds, [1, 8453]);
  await api.getV4UserActivities("0x0000000000000000000000000000000000000001", 1, ["BORROW_SWAP"], "FIFTY");
  assert.deepEqual(calls[1].variables.request.types, ["BORROW_SWAP"]);
  assert.equal(calls[1].variables.request.pageSize, "FIFTY");
  assert.deepEqual(calls[1].variables.request.query.chainIds, [1]);
});

function findChainIds(call) {
  const vars = call.variables?.request;
  if (!vars) return null;
  return vars.filter?.chainIds
    ?? vars.query?.userChains?.chainIds
    ?? vars.query?.chainIds
    ?? vars.filter?.chains?.chainIds
    ?? null;
}

after(() => {
  globalThis.fetch = original;
});
