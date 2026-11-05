import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/v4-meta.json", import.meta.url)));
const KEY = "testkey0123456789abcdef0123456789";
const realFetch = globalThis.fetch;
let calls;

process.env.GRAPH_API_KEY = KEY;
process.env.GRAPH_RETRY_BASE_MS = "1";
process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID = "QmOverrideDeployment111111111111111111111111";

const gc = await import("../../build/graphClient.js");

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (s, t = "err") => new Response("x", { status: s, statusText: t });
function mockFetch(...responders) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responders[Math.min(calls.length - 1, responders.length - 1)];
    return r(url, init);
  };
}

beforeEach(() => { delete process.env.GRAPH_TIMEOUT_MS; delete process.env.GRAPH_MAX_RETRIES; });
afterEach(() => { globalThis.fetch = realFetch; });

test("returns data from fixture; key in Authorization header, not URL", async () => {
  mockFetch(() => ok(FIXTURE));
  const data = await gc.queryChain("QmDep", "{ _meta { block { number } } }");
  assert.deepEqual(data, FIXTURE.data);
  assert.equal(calls[0].url, "https://gateway.thegraph.com/api/deployments/id/QmDep");
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test("querySubgraphId uses subgraphs/id path", async () => {
  mockFetch(() => ok(FIXTURE));
  await gc.querySubgraphId("SubId", "{ x }");
  assert.equal(calls[0].url, "https://gateway.thegraph.com/api/subgraphs/id/SubId");
});

test("retries on 5xx then succeeds", async () => {
  mockFetch(() => status(502), () => status(503), () => ok(FIXTURE));
  const data = await gc.queryChain("QmDep", "{ x }");
  assert.deepEqual(data, FIXTURE.data);
  assert.equal(calls.length, 3);
});

test("retries on 429 and network errors", async () => {
  mockFetch(() => status(429), () => { throw new TypeError("fetch failed"); }, () => ok(FIXTURE));
  await gc.queryChain("QmDep", "{ x }");
  assert.equal(calls.length, 3);
});

test("gives up after max retries (1 + 3 attempts)", async () => {
  mockFetch(() => status(500));
  await assert.rejects(gc.queryChain("QmDep", "{ x }"), (e) => {
    assert.equal(e.statusCode, 500);
    assert.match(e.message, /after 4 attempts/);
    return true;
  });
  assert.equal(calls.length, 4);
});

test("does not retry 4xx (other than 429)", async () => {
  mockFetch(() => status(400));
  await assert.rejects(gc.queryChain("QmDep", "{ x }"), /HTTP 400/);
  assert.equal(calls.length, 1);
});

test("does not retry GraphQL errors", async () => {
  mockFetch(() => ok({ errors: [{ message: "bad field" }] }));
  await assert.rejects(gc.queryChain("QmDep", "{ x }"), /bad field/);
  assert.equal(calls.length, 1);
});

test("times out via AbortController (GRAPH_TIMEOUT_MS) and retries", async () => {
  process.env.GRAPH_TIMEOUT_MS = "20";
  process.env.GRAPH_MAX_RETRIES = "1";
  mockFetch((_u, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
  }));
  await assert.rejects(gc.queryChain("QmDep", "{ x }"), /timed out after 20ms/);
  assert.equal(calls.length, 2);
});

test("redacts API key from errors", async () => {
  mockFetch(() => { throw new TypeError(`connect failed https://gateway.thegraph.com/api/${KEY}/deployments/id/X`); });
  process.env.GRAPH_MAX_RETRIES = "0";
  await assert.rejects(gc.queryChain("QmDep", "{ x }"), (e) => {
    assert.ok(!e.message.includes(KEY), e.message);
    assert.match(e.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(gc.redact(`https://gateway.thegraph.com/api/otherkey/subgraphs/id/S`, KEY),
    "https://gateway.thegraph.com/api/[REDACTED]/subgraphs/id/S");
  assert.equal(gc.redact("https://gateway.thegraph.com/api/subgraphs/id/S", KEY),
    "https://gateway.thegraph.com/api/subgraphs/id/S");
});

test("AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID override applies to exported id and V4 network config", async () => {
  const omni = await import("../../build/v4Omnigraph.js");
  const v4 = await import("../../build/v4Subgraph.js");
  assert.equal(omni.V4_OMNIGRAPH_DEPLOYMENT_ID, process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID);
  assert.equal(v4.V4_NETWORKS.ethereum.id, process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID);
});

test("index.ts has no hardcoded V4 deployment in tool output", () => {
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.ok(!/deployment:\s*"Qm/.test(src));
});
