import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONCENTRATION_SHARE,
  V3_MARKETS,
  analyzeBook,
  bitmapHas,
  effectiveReserveRisk,
  formatTokenAmount,
  isStableAsset,
  jointDropToHf1,
  DUST_COLLATERAL_SHARE,
  DUST_SUPPLY_USD,
  SUPPLY_CAP_SANE_MAX,
  parseUserAddress,
  positionRiskError,
  positionRiskFlags,
  positionSummary,
  priceDeviationPct,
  tokenValueUsd,
} from "../../build/v3PositionRisk.js";

const weth = {
  id: "0xweth",
  symbol: "WETH",
  amount: 1,
  usd: 50,
  priceUsd: 50,
  ltv: 0.8,
  liquidationThreshold: 0.8,
  isStable: false,
  usageAsCollateralEnabled: true,
};
const cbbtc = {
  id: "0xcbbtc",
  symbol: "cbBTC",
  amount: 1,
  usd: 100,
  priceUsd: 100,
  ltv: 0.8,
  liquidationThreshold: 0.8,
  isStable: false,
  usageAsCollateralEnabled: true,
};
const usdcDebt = { id: "0xusdc", symbol: "USDC", amount: 50, usd: 50, priceUsd: 1 };

test("ethereum market addresses are the specified Pool, PoolDataProvider, and Oracle", () => {
  assert.equal(V3_MARKETS.ethereum.pool, "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
  assert.equal(V3_MARKETS.ethereum.poolDataProvider, "0x41393e5e337606dc3821075Af65AeE84D7688CBD");
  assert.equal(V3_MARKETS.ethereum.oracle, "0x54586bE62E3c3580375aE3723C145253060Ca0C2");
  for (const key of ["base", "arbitrum", "polygon", "optimism", "avalanche"]) {
    const market = V3_MARKETS[key];
    for (const field of ["pool", "poolDataProvider", "oracle"]) {
      assert.match(market[field], /^0x[0-9a-fA-F]{40}$/, `${key}.${field}`);
    }
  }
});

test("a joint non-stable drop to HF 1 is 1 - 1/HF when every collateral is volatile", () => {
  const book = analyzeBook({
    collateral: [weth, cbbtc],
    debt: [usdcDebt],
    shocks: [50],
    targetHealthFactor: 1.8,
  });
  // weighted = 50*0.8 + 100*0.8 = 120, HF = 120/50 = 2.4, drop = 1 - 50/120
  assert.ok(Math.abs(book.healthFactor - 2.4) < 1e-12);
  assert.ok(Math.abs(book.jointDropToHealthFactor1.dropPct - (1 - 50 / 120) * 100) < 1e-9);
  assert.equal(book.shocks[0].healthFactor, 1.2);
  const eth = book.perAssetPriceAtHealthFactor1.find((row) => row.symbol === "WETH");
  const btc = book.perAssetPriceAtHealthFactor1.find((row) => row.symbol === "cbBTC");
  assert.equal(eth.status, "cannot liquidate alone");
  assert.equal(eth.priceUsdAtHf1, null);
  assert.equal(btc.status, "price");
  assert.ok(Math.abs(btc.priceUsdAtHf1 - 12.5) < 1e-9);
  assert.ok(Math.abs(btc.dropPctAtHf1 - 87.5) < 1e-9);
});

test("stable collateral is held constant in a joint drop", () => {
  const stable = {
    ...weth,
    id: "0xusdc-col",
    symbol: "USDC",
    usd: 100,
    priceUsd: 1,
    amount: 100,
    isStable: true,
  };
  const volatile = { ...cbbtc, usd: 100, priceUsd: 100 };
  const drop = jointDropToHf1([stable, volatile], 100);
  // stable weighted 80, volatile weighted 80, p = 1 - (100-80)/80 = 0.75
  assert.ok(Math.abs(drop.dropPct - 75) < 1e-9);
  const after = analyzeBook({
    collateral: [stable, volatile],
    debt: [{ ...usdcDebt, usd: 100, amount: 100 }],
    shocks: [50],
    targetHealthFactor: 2,
  });
  // 80 + 80*0.5 = 120, debt 100, HF 1.2
  assert.ok(Math.abs(after.shocks[0].healthFactor - 1.2) < 1e-12);
});

test("repay and collateral add are zero above the target and positive below it", () => {
  const safe = analyzeBook({
    collateral: [weth, cbbtc],
    debt: [usdcDebt],
    shocks: [],
    targetHealthFactor: 1.8,
  });
  assert.equal(safe.alreadyAboveTarget, true);
  assert.equal(safe.repayUsd, 0);
  assert.equal(safe.repay[0].amount, 0);
  assert.equal(safe.collateralAdd[0].amount, 0);
  // extra borrow = 120/1.8 - 50
  assert.ok(Math.abs(safe.extraBorrowUsd - (120 / 1.8 - 50)) < 1e-9);
  const wethOut = safe.withdrawable.find((row) => row.symbol === "WETH");
  // surplus weighted = 120 - 90 = 30; withdraw USD = min(50, 30/0.8) = 37.5; amount = 0.75
  assert.ok(Math.abs(wethOut.amount - 0.75) < 1e-9);
  assert.equal(wethOut.blocked, false);

  const tightDebt = { ...usdcDebt, usd: 100, amount: 100 };
  const tight = analyzeBook({
    collateral: [weth, cbbtc],
    debt: [tightDebt],
    shocks: [],
    targetHealthFactor: 1.8,
  });
  assert.equal(tight.alreadyAboveTarget, false);
  assert.ok(Math.abs(tight.repayUsd - (100 - 120 / 1.8)) < 1e-9);
  assert.ok(Math.abs(tight.repay[0].amount - tight.repayUsd) < 1e-9);
  assert.equal(tight.extraBorrowUsd, 0);
  const addEth = tight.collateralAdd.find((row) => row.symbol === "WETH");
  // deficit weighted = 180 - 120 = 60; USD = 60/0.8 = 75; tokens = 75/50 = 1.5
  assert.ok(Math.abs(addEth.usd - 75) < 1e-9);
  assert.ok(Math.abs(addEth.amount - 1.5) < 1e-9);
  assert.equal(tight.withdrawable[0].amount, 0);
});

test("an LTV-0 collateral blocks withdrawing the other asset", () => {
  const blocked = {
    ...cbbtc,
    id: "0xzero",
    symbol: "ZERO",
    ltv: 0,
    liquidationThreshold: 0.5,
    usd: 40,
    priceUsd: 40,
    amount: 1,
  };
  const book = analyzeBook({
    collateral: [weth, blocked],
    debt: [usdcDebt],
    shocks: [],
    targetHealthFactor: 1.1,
  });
  const eth = book.withdrawable.find((row) => row.symbol === "WETH");
  const zero = book.withdrawable.find((row) => row.symbol === "ZERO");
  assert.equal(eth.blocked, true);
  assert.equal(eth.amount, 0);
  assert.equal(zero.blocked, false);
  assert.ok(zero.amount > 0);
  const flags = positionRiskFlags({
    collateral: [weth, blocked],
    debt: [usdcDebt],
    markets: [],
    healthFactor: book.healthFactor,
    healthFactorFromLegs: book.healthFactor,
  });
  const flag = flags.find((row) => row.code === "zero_ltv_collateral");
  assert.ok(flag);
  assert.match(flag.message, /counts toward the health factor/i);
  assert.match(flag.message, /adds no borrow power/i);
  assert.match(flag.message, /restricts withdrawing other collateral/i);
});

test("supply cap above 95% reports remaining headroom, and concentration uses 80%", () => {
  const flags = positionRiskFlags({
    collateral: [{ ...cbbtc, usd: 90 }, { ...weth, usd: 10 }],
    debt: [usdcDebt],
    markets: [{
      id: "0xcbbtc",
      symbol: "cbBTC",
      isActive: true,
      isFrozen: false,
      isPaused: false,
      supplyCapTokens: 100,
      suppliedTokens: 96,
      priceUsd: 100,
    }],
    healthFactor: 2,
    healthFactorFromLegs: 2,
  });
  const cap = flags.find((row) => row.code === "supply_cap");
  assert.ok(cap);
  assert.match(cap.message, /96\.00% full/);
  assert.match(cap.message, /Headroom remaining: 4 cbBTC/);
  const concentration = flags.filter((row) => row.code === "concentration");
  assert.equal(concentration.length, 2);
  assert.ok(concentration.some((row) => row.asset === "cbBTC" && row.severity === "warning"));
  assert.ok(CONCENTRATION_SHARE === 0.8);
});

test("supply cap flags skip dust, frozen reserves, and absurd percentages", () => {
  const full = {
    id: "0xusdbc",
    symbol: "USDbC",
    isActive: true,
    isFrozen: true,
    isPaused: false,
    supplyCapTokens: 1,
    suppliedTokens: 134542.13,
    priceUsd: 1,
  };
  const frozen = positionRiskFlags({
    collateral: [{ ...weth, id: "0xusdbc", symbol: "USDbC", usd: 50 }],
    debt: [usdcDebt],
    markets: [full],
    healthFactor: 2,
    healthFactorFromLegs: 2,
  });
  assert.equal(frozen.some((row) => row.code === "supply_cap"), false);
  const frozenFlag = frozen.find((row) => row.code === "frozen_reserve");
  assert.match(frozenFlag.message, /frozen/i);
  assert.doesNotMatch(frozenFlag.message, /13454213|13,454,213|% full/);

  const weird = positionRiskFlags({
    collateral: [{ ...weth, id: "0xusdbc", symbol: "USDbC", usd: 50 }],
    debt: [usdcDebt],
    markets: [{ ...full, isFrozen: false }],
    healthFactor: 2,
    healthFactorFromLegs: 2,
  });
  assert.equal(weird.some((row) => row.code === "supply_cap"), false);
  assert.ok(SUPPLY_CAP_SANE_MAX === 2);
  assert.ok(!weird.some((row) => /13454213|13,454,213/.test(row.message)));

  const dust = positionRiskFlags({
    collateral: [{ ...cbbtc, usd: 0.4 }, { ...weth, usd: 10 }],
    debt: [usdcDebt],
    markets: [{
      id: "0xcbbtc",
      symbol: "cbBTC",
      isActive: true,
      isFrozen: false,
      isPaused: false,
      supplyCapTokens: 100,
      suppliedTokens: 96,
      priceUsd: 100,
    }],
    healthFactor: 2,
    healthFactorFromLegs: 2,
  });
  assert.equal(dust.some((row) => row.code === "supply_cap"), false);
  assert.equal(DUST_SUPPLY_USD, 1);

  const share = positionRiskFlags({
    collateral: [{ ...cbbtc, usd: 5 }, { ...weth, usd: 9995 }],
    debt: [usdcDebt],
    markets: [{
      id: "0xcbbtc",
      symbol: "cbBTC",
      isActive: true,
      isFrozen: false,
      isPaused: false,
      supplyCapTokens: 100,
      suppliedTokens: 99,
      priceUsd: 100,
    }],
    healthFactor: 2,
    healthFactorFromLegs: 2,
  });
  assert.equal(share.some((row) => row.code === "supply_cap"), false);
  assert.equal(DUST_COLLATERAL_SHARE, 0.001);
});

test("a malformed address is invalid before any RPC hint, and an empty book is no open position", () => {
  assert.throws(() => parseUserAddress("not-an-address"), /invalid address/i);
  assert.throws(() => parseUserAddress("0x123"), /invalid address/i);
  assert.throws(() => parseUserAddress(""), /invalid address/i);
  const checksummed = parseUserAddress("0xa6f8509c623e23019f52f8e5d7776ca05641c359");
  assert.equal(checksummed, "0xa6f8509C623e23019f52F8E5d7776Ca05641c359");

  const addressError = positionRiskError(
    "ethereum",
    new Error('Invalid address: "nope". Expected a 0x-prefixed 20-byte hex address.')
  );
  assert.match(addressError.message, /invalid address/i);
  assert.doesNotMatch(addressError.message, /RPC endpoint/);

  const rpcError = positionRiskError("ethereum", new Error("HTTP request failed"));
  assert.match(rpcError.message, /Tried \d+ RPC endpoint/);

  const empty = positionSummary({
    chain: "base",
    blockNumber: "1",
    healthFactorText: "infinity",
    collateral: [],
    debt: [],
    jointDropPct: null,
    jointDropReason: "no debt",
    cannotLiquidateAlone: [],
  });
  assert.match(empty, /no open position/i);
  assert.match(empty, /no supplies and no debt/i);
  assert.doesNotMatch(empty, /Every collateral asset can reach HF 1/);

  const open = positionSummary({
    chain: "ethereum",
    blockNumber: "2",
    healthFactorText: "2.1000",
    collateral: [{ amount: "1", symbol: "WETH", usd: 100 }],
    debt: [{ amount: "40", symbol: "USDC", usd: 40 }],
    jointDropPct: 50,
    jointDropReason: null,
    cannotLiquidateAlone: ["WETH"],
  });
  assert.match(open, /HF 2.1000/);
  assert.match(open, /WETH cannot liquidate alone/);
});

test("subgraph deviation warns only above 2%", () => {
  assert.ok(priceDeviationPct(100, 103) > 2);
  assert.ok(priceDeviationPct(100, 101) < 2);
  const flags = positionRiskFlags({
    collateral: [weth],
    debt: [usdcDebt],
    markets: [],
    healthFactor: 2,
    healthFactorFromLegs: 2,
    deviations: [
      { symbol: "cbBTC", oracleUsd: 61000, subgraphUsd: 103900, deviationPct: 70.327 },
      { symbol: "WETH", oracleUsd: 1700, subgraphUsd: 1710, deviationPct: 0.59 },
    ],
  });
  const warnings = flags.filter((row) => row.code === "subgraph_price_deviation");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].asset, "cbBTC");
});

test("e-mode overrides LT and LTV on the collateral bitmap and can zero LTV", () => {
  const eMode = {
    categoryId: 1,
    ltvBps: 9300,
    liquidationThresholdBps: 9500,
    liquidationBonusBps: 10100,
    priceSource: "0x0000000000000000000000000000000000000000",
    collateralBitmap: 1n << 2n,
    borrowableBitmap: 1n << 2n,
    ltvzeroBitmap: 0n,
    isolated: false,
  };
  const on = effectiveReserveRisk({
    reserveIndex: 2,
    ltvBps: 8000,
    liquidationThresholdBps: 8250,
    priceUsd: 10,
    eMode,
    priceSourceUsd: null,
  });
  assert.equal(on.ltvBps, 9300);
  assert.equal(on.liquidationThresholdBps, 9500);
  assert.equal(on.inEMode, true);
  assert.equal(on.usedPriceSource, false);
  const off = effectiveReserveRisk({
    reserveIndex: 3,
    ltvBps: 8000,
    liquidationThresholdBps: 8250,
    priceUsd: 10,
    eMode,
    priceSourceUsd: null,
  });
  assert.equal(off.ltvBps, 8000);
  assert.equal(off.liquidationThresholdBps, 8250);
  const ltvZero = effectiveReserveRisk({
    reserveIndex: 2,
    ltvBps: 8000,
    liquidationThresholdBps: 8250,
    priceUsd: 10,
    eMode: { ...eMode, ltvzeroBitmap: 1n << 2n },
    priceSourceUsd: null,
  });
  assert.equal(ltvZero.ltvBps, 0);
  assert.equal(ltvZero.liquidationThresholdBps, 9500);
  const priced = effectiveReserveRisk({
    reserveIndex: 2,
    ltvBps: 8000,
    liquidationThresholdBps: 8250,
    priceUsd: 10,
    eMode: { ...eMode, priceSource: "0x1111111111111111111111111111111111111111" },
    priceSourceUsd: 42,
  });
  assert.equal(priced.priceUsd, 42);
  assert.equal(priced.usedPriceSource, true);
  assert.equal(bitmapHas(eMode.collateralBitmap, 2), true);
  assert.equal(bitmapHas(eMode.collateralBitmap, 1), false);
});

test("isolated e-mode gives LTV 0 to collateral outside the bitmap", () => {
  const isolated = effectiveReserveRisk({
    reserveIndex: 4,
    ltvBps: 7500,
    liquidationThresholdBps: 8000,
    priceUsd: 3,
    eMode: {
      categoryId: 2,
      ltvBps: 9000,
      liquidationThresholdBps: 9300,
      liquidationBonusBps: 10100,
      priceSource: "0x0000000000000000000000000000000000000000",
      collateralBitmap: 1n,
      borrowableBitmap: 1n,
      ltvzeroBitmap: 0n,
      isolated: true,
    },
    priceSourceUsd: null,
  });
  assert.equal(isolated.ltvBps, 0);
  assert.equal(isolated.liquidationThresholdBps, 8000);
  assert.equal(isolated.inEMode, false);
});

test("stables are the symbol list plus a tight one-dollar band", () => {
  assert.equal(isStableAsset("USDC", 0.9998), true);
  assert.equal(isStableAsset("WETH", 1712), false);
  assert.equal(isStableAsset("cbBTC", 60769), false);
  assert.equal(isStableAsset("NEWUSD", 1.0), true);
  assert.equal(isStableAsset("sUSDe", 1.2), false);
});

test("token USD and display amounts match the 22 Nov 2026 Ethereum wallet shape", () => {
  const base = 100_000_000n;
  const wethUsd = tokenValueUsd(35000061742063903558n, 18, 171262071296n, base);
  const btcAmount = formatTokenAmount(148155865n, 8);
  const btcUsd = tokenValueUsd(148155865n, 8, 6076942112853n, base);
  const usdcAmount = formatTokenAmount(60300280605n, 6);
  const usdcUsd = tokenValueUsd(60300280605n, 6, 99984000n, base);
  assert.equal(formatTokenAmount(35000061742063903558n, 18), "35.00006174");
  assert.equal(btcAmount, "1.48155865");
  assert.equal(usdcAmount, "60300.280605");
  const book = analyzeBook({
    collateral: [
      {
        id: "weth",
        symbol: "WETH",
        amount: 35.00006174,
        usd: wethUsd,
        priceUsd: 1712.62071296,
        ltv: 0.81,
        liquidationThreshold: 0.84,
        isStable: false,
        usageAsCollateralEnabled: true,
      },
      {
        id: "cbbtc",
        symbol: "cbBTC",
        amount: 1.48155865,
        usd: btcUsd,
        priceUsd: 60769.42112853,
        ltv: 0.81,
        liquidationThreshold: 0.85,
        isStable: false,
        usageAsCollateralEnabled: true,
      },
    ],
    debt: [{ id: "usdc", symbol: "USDC", amount: 60300.280605, usd: usdcUsd, priceUsd: 0.99984 }],
    shocks: [5, 10, 20, 30, 50],
    targetHealthFactor: 1.8,
  });
  assert.ok(book.healthFactor > 2.05 && book.healthFactor < 2.15, `HF ${book.healthFactor}`);
  assert.ok(book.jointDropToHealthFactor1.dropPct > 51 && book.jointDropToHealthFactor1.dropPct < 54);
  const eth = book.perAssetPriceAtHealthFactor1.find((row) => row.symbol === "WETH");
  assert.equal(eth.status, "cannot liquidate alone");
  assert.equal(book.repayUsd, 0);
  assert.equal(book.collateralAddUsd, 0);
  assert.ok(book.extraBorrowUsd > 0);
  // 50% shock stays above 1 because the HF-1 drop is ~52.5%.
  assert.ok(book.shocks.find((row) => row.dropPct === 50).healthFactor > 1);
});
