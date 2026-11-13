import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXAMPLE_ACCOUNTS,
  EXAMPLE_PARAMS,
  breakEvenGap,
  gapsFromPct,
  group,
  hf,
  simulateGapShock,
} from "../../build/stocksGap.js";
import { legsFromHolders } from "../../build/stocksSnapshot.js";

test("example books match HF at a zero gap", () => {
  const [safe, tight, idle] = EXAMPLE_ACCOUNTS;
  assert.equal(hf(safe, EXAMPLE_PARAMS), 1000 * 0.65 / 400);
  assert.ok(Math.abs(hf(tight, EXAMPLE_PARAMS) - (650 / 640)) < 1e-12);
  assert.equal(hf(idle, EXAMPLE_PARAMS), Number.POSITIVE_INFINITY);
  assert.equal(simulateGapShock(EXAMPLE_ACCOUNTS, EXAMPLE_PARAMS, gapsFromPct(0)).liquidatableCount, 0);
});

test("a -50% gap liquidates more debt, and debt at risk rises as the gap worsens", () => {
  const points = [0, -10, -20, -50];
  const risks = points.map((pct) =>
    simulateGapShock(EXAMPLE_ACCOUNTS, EXAMPLE_PARAMS, gapsFromPct(pct)).debtAtRisk
  );
  for (let i = 1; i < risks.length; i++) {
    assert.ok(risks[i] >= risks[i - 1], `${points[i]} should not reduce debt at risk`);
  }
  const mild = simulateGapShock(EXAMPLE_ACCOUNTS, EXAMPLE_PARAMS, gapsFromPct(0));
  const crash = simulateGapShock(EXAMPLE_ACCOUNTS, EXAMPLE_PARAMS, gapsFromPct(-50));
  assert.ok(crash.liquidatableCount > mild.liquidatableCount);
  assert.equal(risks[0], 0);
  assert.equal(risks[risks.length - 1], 400 + 640);
});

test("break-even gap is the move that takes the safe book to HF 1", () => {
  const safe = EXAMPLE_ACCOUNTS[0];
  const gap = breakEvenGap(safe, EXAMPLE_PARAMS);
  assert.ok(gap != null);
  const at = hf(safe, EXAMPLE_PARAMS, { TSLAc: gap });
  assert.ok(Math.abs(at - 1) < 1e-9);
});

test("group merges collateral and debt legs for one user", () => {
  const accounts = group(legsFromHolders({
    supplied: [{ symbol: "TSLAc", holders: [{ address: "0xABC", usd: 100 }, { address: "0xabc", usd: 50 }] }],
    borrowed: [{ symbol: "USDC", holders: [{ address: "0xAbC", usd: 40 }] }],
  }));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].collateral.TSLAc, 150);
  assert.equal(accounts[0].debt, 40);
});
