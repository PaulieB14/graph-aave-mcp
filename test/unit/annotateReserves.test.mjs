import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateReserves, attachSubgraphMeta } from "../../build/reserveAnnotate.js";
import { rayToAPY, rayToAPR } from "../../build/rates.js";

// 4.68% APR in RAY. Compounded per-second APY is the Aave UI figure (~4.79%).
const APR_468_RAY = (468n * 10n ** 23n).toString();

test("rayToAPY compounds a 4.68% APR ray to 4.79%", () => {
  assert.equal(rayToAPR(APR_468_RAY), "4.68%");
  const apy = Number(rayToAPY(APR_468_RAY).replace("%", ""));
  assert.ok(Math.abs(apy - 4.79) <= 0.02, `expected ~4.79, got ${apy}`);
});

test("annotateReserves derives available liquidity and uses compounded APY", () => {
  const out = annotateReserves({
    reserves: [{
      symbol: "USDC",
      decimals: 6,
      totalLiquidity: "2309212859000000",
      totalATokenSupply: "2309212859000000",
      totalCurrentVariableDebt: "2184281529000000",
      totalPrincipalStableDebt: "0",
      availableLiquidity: "100273893000000",
      liquidityRate: APR_468_RAY,
      variableBorrowRate: APR_468_RAY,
      utilizationRate: "0.94",
    }],
  });
  const human = out.reserves[0]._humanReadable;
  assert.equal(human.availableLiquidity, "124.93M USDC");
  assert.equal(human.availableLiquiditySubgraphRaw, "100.27M USDC");
  assert.equal(human.availableLiquiditySource, "totalATokenSupply - (variable + stable debt)");
  assert.equal(out.reserves[0].availableLiquidityDerived, "124931330000000");
  assert.notEqual(human.supplyAPY, human.supplyAPR);
  assert.equal(human.supplyAPR, "4.68%");
  const apy = Number(human.supplyAPY.replace("%", ""));
  assert.ok(Math.abs(apy - 4.79) <= 0.02);
});

test("annotateReserves falls back to raw availableLiquidity", () => {
  const out = annotateReserves({
    reserves: [{
      symbol: "DAI",
      decimals: 18,
      totalLiquidity: "1000000000000000000",
      availableLiquidity: "1000000000000000000",
      utilizationRate: "0",
    }],
  });
  assert.equal(out.reserves[0]._humanReadable.availableLiquiditySource, "subgraph availableLiquidity (fallback)");
});

test("attachSubgraphMeta computes lagSeconds from a fixed clock", () => {
  const fetchedAtMs = 1_793_926_700_000;
  const out = attachSubgraphMeta(
    { reserves: [], _meta: { block: { number: 26352368, timestamp: 1793926691 } } },
    fetchedAtMs
  );
  assert.equal(out._freshness.block, 26352368);
  assert.equal(out._freshness.timestamp, 1793926691);
  assert.equal(out._freshness.lagSeconds, 9);
  assert.equal(out._freshness.source, "thegraph-subgraph");
});
