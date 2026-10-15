#!/usr/bin/env node
/**
 * Smoke test: start the server over stdio, list every tool, and call each one.
 *
 * Why this exists: `get_v4_hub_flows` shipped pointing at a Graph Studio
 * subgraph that had been undeployed. Studio answers a missing subgraph with
 * HTTP 200 and `{"message":"Not found"}`, the client only checked
 * `json.errors`, and the tool returned `flows: []` — indistinguishable from
 * "no activity on chain". Nothing caught it because nothing ever called the
 * tool. This server is a wrapper over two external APIs, so upstream drift is
 * the main failure mode and it needs to be exercised, not assumed.
 *
 * A tool that returns an empty collection is reported as EMPTY, not passed:
 * that is exactly what a silently-dead backend looks like.
 *
 * Usage:  node test/smoke.mjs            (skips subgraph tools without a key)
 *         GRAPH_API_KEY=... node test/smoke.mjs
 */
import { spawn } from "node:child_process";

const HAS_KEY = Boolean(process.env.GRAPH_API_KEY);

/**
 * Tools that read chain state directly. Without a reachable RPC these fail for
 * environmental reasons, not code reasons — viem's unconfigured fallback is
 * blocked or rate-limited on many networks. Probe once and skip rather than
 * reporting a red suite for something the code cannot control.
 */
const RPC_TOOLS = new Set(["get_live_user_account_data", "get_live_reserve_detail"]);
async function rpcReachable() {
  const url = process.env.ETHEREUM_RPC_URL;
  try {
    const res = await fetch(url || "https://cloudflare-eth.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return Boolean(j?.result);
  } catch {
    return false;
  }
}
const HAS_RPC = await rpcReachable();
const CHAIN = "ethereum";
const RISK_CHAIN = "risk-ethereum";
const WHALE = "0xfff9b09d83f5ecaab3d75fd7fc846cc9b419d26e";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** Args per tool. `null` means "expected to fail without a live backend". */
const ARGS = {
  list_aave_chains: {},
  get_aave_reserves: { chain: CHAIN, symbols: ["USDC"] },
  get_aave_reserve: { chain: CHAIN, symbol: "USDC" },
  get_aave_user_position: { chain: CHAIN, userAddress: WHALE },
  simulate_health_factor: { chain: CHAIN, userAddress: WHALE, assetSymbol: "USDC", priceChangePct: -10 },
  get_recent_borrows: { chain: CHAIN },
  get_recent_supplies: { chain: CHAIN },
  get_aave_liquidations: { chain: CHAIN },
  get_aave_repays: { chain: CHAIN },
  get_aave_flash_loans: { chain: CHAIN },
  get_reserve_rate_history: { chain: CHAIN, reserveId: `${USDC}0x2f39d218133afab8f2b819b1066c7e434ad94e9e` },
  find_best_rates: { asset: "USDC" },
  get_governance_proposals: {},
  get_proposal_votes: { proposalId: "515" },
  query_aave_subgraph: { chain: CHAIN, query: "{ reserves(first: 1) { symbol } }" },
  get_aave_schema: { chain: CHAIN },
  get_at_risk_positions: { chain: RISK_CHAIN },
  get_user_risk_profile: { chain: RISK_CHAIN, userAddress: WHALE },
  get_protocol_risk_stats: { chain: RISK_CHAIN },
  get_risk_alerts: { chain: RISK_CHAIN },
  get_risk_liquidations: { chain: RISK_CHAIN },
  get_health_factor_history: { chain: RISK_CHAIN, userAddress: WHALE },
  get_cross_chain_risk_summary: {},
  list_risk_chains: {},
  get_live_user_account_data: { chain: CHAIN, userAddress: WHALE },
  get_live_reserve_detail: { chain: CHAIN, assetAddress: USDC },
  note_finding: { text: "smoke-test finding" },
  get_session_state: {},
  list_findings: {},
  delete_finding: null,          // needs an id from note_finding; covered manually
  get_v4_hubs: {},
  get_v4_spokes: {},
  get_v4_reserves: { symbols: ["USDC"], compact: true },
  get_v4_chains: {},
  get_v4_exchange_rate: { native: true, chainId: 1 },
  get_v4_asset: { tokenAddress: USDC, chainId: 1 },
  get_v4_asset_price_history: { tokenAddress: WETH, chainId: 1 },
  get_v4_protocol_history: {},
  get_v4_user_positions: { userAddress: WHALE },
  get_v4_user_summary: { userAddress: WHALE },
  get_v4_user_supplies: { userAddress: WHALE },
  get_v4_user_borrows: { userAddress: WHALE },
  get_v4_user_balances: { userAddress: WHALE },
  get_v4_user_activities: { userAddress: WHALE },
  get_v4_claimable_rewards: { userAddress: WHALE },
  get_v4_swap_quote: { sellTokenAddress: USDC, buyTokenAddress: WETH, sellAmount: "1000000", userAddress: WHALE },
  get_v4_hub_flows: { limit: 3 },
  get_v4_user_risk_trajectory: { userAddress: WHALE, limit: 3 },
  get_v4_liquidation_postmortem: { userAddress: WHALE, limit: 3 },
  get_v4_treasury_flows: { limit: 3 },
  get_v4_spoke_config_history: { spokeAddress: "0xba1b3d55d249692b669a164024a838309b7508af", limit: 3 },
  // V4 subgraph, Base default (Coinbase stocks hub)
  get_v4_recent_liquidations: { limit: 3 },
  get_v4_hub_assets: {},
  get_v4_config_changes: { limit: 3 },
  get_v4_hub_daily_flows: { days: 7 },
  get_v4_user_activity: { user: "0x23cad661e2c5f4290a9d1b08209a2a03d7426e29", limit: 3 },
  get_v4_treasury_events: { limit: 3 },
};

/**
 * Tools where an EMPTY collection means the backend is broken, not that the
 * answer is legitimately empty.
 *
 * The distinction matters and getting it wrong in either direction is bad. A
 * protocol-wide list that comes back empty is a dead backend. A per-user query
 * that comes back empty usually just means that user has no position — V4 is
 * new and most addresses have none — and failing on that would train everyone
 * to ignore the suite.
 */
const EXPECT_DATA = new Set([
  "list_aave_chains", "get_aave_reserves", "get_aave_reserve", "get_recent_borrows",
  "get_recent_supplies", "get_aave_liquidations", "get_aave_repays", "find_best_rates",
  "get_governance_proposals", "get_aave_schema", "get_at_risk_positions",
  "get_protocol_risk_stats", "list_risk_chains", "get_cross_chain_risk_summary",
  "get_v4_hubs", "get_v4_spokes", "get_v4_reserves", "get_v4_chains",
  "get_v4_protocol_history", "get_v4_hub_flows",
  "get_v4_recent_liquidations", "get_v4_hub_assets", "get_v4_config_changes", "get_v4_hub_daily_flows",
]);

/** Tools that cannot pass right now, with the reason. Keeps the run green
 *  while staying honest — remove an entry the moment its backend is fixed. */
const KNOWN_BROKEN = {};

const NEEDS_KEY = new Set([
  "get_aave_reserves","get_aave_reserve","get_aave_user_position","simulate_health_factor",
  "get_recent_borrows","get_recent_supplies","get_aave_liquidations","get_aave_repays",
  "get_aave_flash_loans","get_reserve_rate_history","find_best_rates","get_governance_proposals",
  "get_proposal_votes","query_aave_subgraph","get_aave_schema","get_at_risk_positions",
  "get_user_risk_profile","get_protocol_risk_stats","get_risk_alerts","get_risk_liquidations",
  "get_health_factor_history","get_cross_chain_risk_summary",
  // Omnigraph tools query the decentralized network through the gateway.
  "get_v4_hub_flows","get_v4_user_risk_trajectory","get_v4_liquidation_postmortem",
  "get_v4_treasury_flows","get_v4_spoke_config_history",
  "get_v4_recent_liquidations","get_v4_hub_assets","get_v4_config_changes","get_v4_hub_daily_flows","get_v4_user_activity","get_v4_treasury_events",
]);

const proc = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* server logs to stderr; ignore non-JSON */ }
  }
});
const send = (id, method, params, ms = 60000) =>
  new Promise((res) => {
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __timeout: true }); } }, ms);
  });

let id = 100;
await send(id++, "initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const listed = await send(id++, "tools/list", {});
const tools = listed.result?.tools ?? [];
const listBytes = JSON.stringify(tools).length;
console.log(`tools/list: ${tools.length} tools, ${listBytes.toLocaleString()} bytes (~${Math.round(listBytes / 4).toLocaleString()} tokens)`);
console.log(HAS_KEY ? "GRAPH_API_KEY present — testing subgraph tools too"
                    : "no GRAPH_API_KEY — skipping subgraph-backed tools");
console.log(HAS_RPC ? "Ethereum RPC reachable — testing live on-chain tools too\n"
                    : "no reachable Ethereum RPC — skipping live tools (set ETHEREUM_RPC_URL)\n");

const missing = tools.map((t) => t.name).filter((n) => !(n in ARGS));
if (missing.length) {
  console.log(`FAIL: ${missing.length} tool(s) have no smoke coverage: ${missing.join(", ")}\n`);
}

let pass = 0, skip = 0, known = 0;
const failures = [];
for (const t of tools) {
  const name = t.name;
  const args = ARGS[name];
  if (args === null) { skip++; console.log(`SKIP  ${name} (needs state from another call)`); continue; }
  if (!HAS_KEY && NEEDS_KEY.has(name)) { skip++; console.log(`SKIP  ${name} (needs GRAPH_API_KEY)`); continue; }
  if (!HAS_RPC && RPC_TOOLS.has(name)) { skip++; console.log(`SKIP  ${name} (needs a reachable RPC — set ETHEREUM_RPC_URL)`); continue; }

  const r = await send(id++, "tools/call", { name, arguments: args });
  const text = (r.result?.content ?? []).map((c) => c.text ?? "").join("");
  let verdict;
  if (r.__timeout) verdict = "TIMEOUT";
  else if (r.error) verdict = "RPC_ERROR";
  else if (r.result?.isError) verdict = "TOOL_ERROR";
  else if (!text.trim()) verdict = "EMPTY";
  else {
    // A dead backend usually looks like a well-formed empty collection — but
    // only treat that as a failure where data is genuinely expected.
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    const arrays = parsed && typeof parsed === "object"
      ? Object.values(parsed).filter(Array.isArray) : [];
    const nested = parsed?.data && typeof parsed.data === "object"
      ? Object.values(parsed.data).filter(Array.isArray) : [];
    const all = [...arrays, ...nested];
    const allEmpty = all.length > 0 && all.every((a) => a.length === 0);
    if (!allEmpty) verdict = "OK";
    else verdict = EXPECT_DATA.has(name) ? "EMPTY" : "OK_EMPTY";
  }

  if (verdict === "OK") { pass++; console.log(`ok    ${name}  (${text.length.toLocaleString()}B)`); }
  else if (verdict === "OK_EMPTY") { pass++; console.log(`ok    ${name}  (empty — no data for this address, not a failure)`); }
  else if (KNOWN_BROKEN[name]) { known++; console.log(`known ${name} — ${KNOWN_BROKEN[name]}`); }
  else { failures.push({ name, verdict, detail: text.replace(/\s+/g, " ").slice(0, 160) }); console.log(`FAIL  ${name} [${verdict}] ${text.replace(/\s+/g, " ").slice(0, 160)}`); }
}

console.log(`\n${pass} ok, ${failures.length} failed, ${skip} skipped, ${known} known-broken`);
proc.kill();
if (failures.length || missing.length) process.exit(1);
