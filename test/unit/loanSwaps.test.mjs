import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateLoanSwaps,
  crossCheckLoanSwaps,
  mergeLoanSwaps,
  normalizeBorrowSwapActivity,
  pairRepayBorrow,
  COW_FLASH_LOAN_ROUTER,
} from "../../build/loanSwaps.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/borrow-swap-activity.json", import.meta.url)));

test("normalizeBorrowSwapActivity maps sell to from-asset and buy to to-asset", () => {
  const swap = normalizeBorrowSwapActivity(fixture);
  assert.equal(swap.source, "aave-v4-api");
  assert.equal(swap.chainId, 1);
  assert.equal(swap.fromAsset, "USDt");
  assert.equal(swap.toAsset, "USDC");
  assert.equal(swap.fromAmount, "1004.396320");
  assert.equal(swap.toAmount, "1006.018691");
  assert.equal(swap.fromUsd, 1003.3216);
  assert.equal(swap.user.toLowerCase(), "0x4604fca1451fb16bd86b10835d569e9e70c4327d");
  assert.equal(swap.txHash, fixture.txHash);
  assert.equal(swap.timestamp, "2026-11-12T18:16:23+00:00");
});

test("pairRepayBorrow keeps same-tx repay plus borrow and flags the CoW router", () => {
  const tx = "0xbc0e0e764b87f62de8a027913561d84aa8b919791051760c783e51d37b5a657c";
  const user = "0x4604fca1451fb16bd86b10835d569e9e70c4327d";
  const rows = [
    { type: "REPAY", amount: "1004396320", timestamp: "1762964183", txHash: tx, caller: COW_FLASH_LOAN_ROUTER, user: { id: user }, reserve: { assetId: "8", symbol: "USDt" } },
    { type: "BORROW", amount: "1006018691", timestamp: "1762964183", txHash: tx, caller: user, user: { id: user }, reserve: { assetId: "7", symbol: "USDC" } },
    { type: "REPAY", amount: "1", timestamp: "1", txHash: "0xabc", caller: user, user: { id: user }, reserve: { assetId: "1" } },
    { type: "BORROW", amount: "9", timestamp: "1", txHash: "0xdef", caller: user, user: { id: "0x9999999999999999999999999999999999999999" }, reserve: { assetId: "2" } },
  ];
  const pairs = pairRepayBorrow(rows, 1);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].fromAsset, "USDt");
  assert.equal(pairs[0].toAsset, "USDC");
  assert.equal(pairs[0].cowRouted, true);
  assert.equal(pairs[0].source, "subgraph-repay-borrow");
});

test("cross-check matches API swaps to subgraph pairs by transaction", () => {
  const api = [normalizeBorrowSwapActivity(fixture)];
  const sub = pairRepayBorrow([
    { type: "REPAY", amount: "1", timestamp: "1762964183", txHash: fixture.txHash, user: { id: fixture.user }, reserve: { assetId: "8" } },
    { type: "BORROW", amount: "1", timestamp: "1762964183", txHash: fixture.txHash, user: { id: fixture.user }, reserve: { assetId: "7" } },
  ], 1);
  const check = crossCheckLoanSwaps(api, sub);
  assert.equal(check.matchedTxs.length, 1);
  assert.equal(check.apiOnlyTxs.length, 0);
  const merged = mergeLoanSwaps(api, sub);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "aave-v4-api");
});

test("aggregateLoanSwaps ranks from-to pairs and counts users inside the window", () => {
  const older = normalizeBorrowSwapActivity({
    ...fixture,
    timestamp: "2026-10-01T00:00:00Z",
    txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    user: "0x00000000000000000000000000000000000000aa",
  });
  const second = normalizeBorrowSwapActivity({
    ...fixture,
    user: "0x00000000000000000000000000000000000000bb",
    txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    sell: { ...fixture.sell, amount: { ...fixture.sell.amount, exchange: { value: "10" } }, reserve: { asset: { underlying: { info: { symbol: "WETH" } } } }, token: { info: { symbol: "WETH" } } },
  });
  // force fromAsset via token symbol path: normalize prefers token.info.symbol
  second.fromAsset = "WETH";
  const stats = aggregateLoanSwaps([normalizeBorrowSwapActivity(fixture), second, older], {
    windowHours: 24 * 30,
    nowMs: Date.parse("2026-11-13T00:00:00Z"),
  });
  assert.equal(stats.count, 2);
  assert.equal(stats.uniqueUsers, 2);
  assert.ok(stats.volumeUsd > 1000);
  assert.equal(stats.topPairs[0].from, "USDt");
  assert.equal(stats.topPairs[0].to, "USDC");
});
