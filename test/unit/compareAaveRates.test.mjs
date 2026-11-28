import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATE_SYMBOLS,
  apyPercent,
  compareAaveRates,
  marketAccess,
  marketLabel,
  normalizeRateSymbol,
  rankAaveRates,
} from "../../build/compareAaveRates.js";

function reserve(symbol, opts = {}) {
  return {
    underlyingToken: { symbol },
    isFrozen: opts.frozen ?? false,
    isPaused: opts.paused ?? false,
    supplyInfo: {
      apy: { formatted: opts.supplyFormatted ?? "1.00", value: String((opts.supplyPct ?? 1) / 100) },
      supplyCapReached: opts.supplyCapReached ?? false,
    },
    borrowInfo: opts.noBorrow
      ? null
      : {
          apy: { formatted: opts.borrowFormatted ?? "2.00", value: String((opts.borrowPct ?? 2) / 100) },
          availableLiquidity: {
            amount: { value: String(opts.tokens ?? opts.liq ?? 0) },
            usd: String(opts.liq ?? 0),
          },
          borrowingState: opts.state ?? "ENABLED",
        },
  };
}

function market(name, chain, chainId, reserves) {
  return { name, chain: { name, chainId }, reserves };
}

const FIXTURE = [
  market("AaveV3Ethereum", "Ethereum", 1, [
    reserve("USDC", { borrowPct: 4.36, borrowFormatted: "4.36", supplyPct: 3.1, supplyFormatted: "3.10", liq: 800_000_000 }),
    reserve("WETH", { borrowPct: 2.1, liq: 50_000_000 }),
  ]),
  market("AaveV3EthereumEtherFi", "Ethereum", 1, [
    reserve("USDC", { borrowPct: 1.7, borrowFormatted: "1.70", liq: 6300 }),
    reserve("PYUSD", { borrowPct: 0, borrowFormatted: "0.00", liq: 111 }),
  ]),
  market("AaveV3EthereumLido", "Ethereum", 1, [
    reserve("USDC", { borrowPct: 4.13, borrowFormatted: "4.13", liq: 1_400_000 }),
  ]),
  market("AaveV3EthereumHorizon", "Ethereum", 1, [
    reserve("GHO", { borrowPct: 3.3, borrowFormatted: "3.30", liq: 48_000_000 }),
  ]),
  market("AaveV3Ink", "Ink", 57073, [
    reserve("USDe", { borrowPct: 0, borrowFormatted: "0.00", liq: 270_000_000, state: "DISABLED" }),
  ]),
  market("AaveV3Gnosis", "Gnosis", 100, [
    reserve("USDC", { borrowPct: 1.07, borrowFormatted: "1.07", liq: 120_000, frozen: true }),
  ]),
  market("AaveV3Polygon", "Polygon", 137, [
    reserve("USD₮0", { borrowPct: 5.5, borrowFormatted: "5.50", liq: 2_000_000 }),
    reserve("USDC.e", { borrowPct: 4.8, borrowFormatted: "4.80", liq: 900_000 }),
  ]),
  market("AaveV3Base", "Base", 8453, [
    reserve("USDC", { borrowPct: 5.2, borrowFormatted: "5.20", supplyPct: 4.4, supplyFormatted: "4.40", liq: 250_000 }),
    reserve("m.USDC", { borrowPct: 0.1, borrowFormatted: "0.10", liq: 9_000_000 }),
  ]),
];

test("symbol matching treats USD₮0 as USDT0 and keeps USDC distinct from USDC.e", () => {
  assert.equal(normalizeRateSymbol("usd₮0"), "USDT0");
  assert.equal(normalizeRateSymbol("USDt"), "USDT");
  assert.notEqual(normalizeRateSymbol("USDC"), normalizeRateSymbol("USDC.e"));
  assert.equal(marketLabel("AaveV3Ethereum"), "Ethereum Core");
  assert.equal(marketLabel("AaveV3EthereumHorizon"), "Ethereum Horizon");
  assert.equal(marketAccess("AaveV3EthereumHorizon").permissioned, true);
  assert.equal(marketAccess("AaveV3EthereumEtherFi").restrictedCollateral, true);
  assert.equal(apyPercent({ value: "0.0436", formatted: "4.36" }), 4.36);
});

test("borrow ranking is cheapest usable market first and filters size", () => {
  const ranked = rankAaveRates(FIXTURE, {});
  assert.deepEqual(ranked.symbols, [...DEFAULT_RATE_SYMBOLS]);
  const symbols = new Set(ranked.results.map((row) => normalizeRateSymbol(row.symbol)));
  assert.equal(symbols.has("WETH"), false);
  assert.equal(symbols.has("MUSDC") || ranked.results.some((row) => row.symbol === "m.USDC"), false);

  const borrowable = ranked.results.filter((row) => row.borrowable);
  const apys = borrowable.map((row) => row.borrowApyPct);
  const sorted = [...apys].sort((a, b) => a - b);
  assert.deepEqual(apys, sorted);
  assert.equal(borrowable[0].market, "Ethereum EtherFi");
  assert.equal(borrowable[0].symbol, "PYUSD");
  assert.ok(borrowable[0].notes.some((note) => /restricted-collateral/i.test(note)));

  const disabled = ranked.results.find((row) => row.market === "Ink" && row.symbol === "USDe");
  assert.equal(disabled.borrowable, false);
  assert.ok(ranked.results.indexOf(disabled) > ranked.results.indexOf(borrowable[0]));

  const frozen = ranked.results.find((row) => row.market === "Gnosis");
  assert.equal(frozen.borrowable, false);
  assert.ok(frozen.notes.some((note) => /frozen/i.test(note)));

  const horizon = ranked.results.find((row) => row.market === "Ethereum Horizon");
  assert.equal(horizon.permissioned, true);
  assert.ok(horizon.notes.some((note) => /permissioned institutional/i.test(note)));

  const usdt0 = ranked.results.find((row) => row.symbol === "USD₮0");
  assert.equal(usdt0.market, "Polygon");
  assert.ok(ranked.results.some((row) => row.symbol === "USDC.e"));

  const sized = rankAaveRates(FIXTURE, { symbols: ["USDC", "PYUSD", "GHO"], amountUsd: 60_000 });
  const kept = sized.results.map((row) => `${row.market}:${row.symbol}`);
  assert.equal(kept.includes("Ethereum EtherFi:USDC"), false);
  assert.equal(kept.includes("Ethereum EtherFi:PYUSD"), false);
  assert.ok(sized.filtered.some((row) => row.symbol === "USDC" && /exceeds available liquidity/.test(row.reason)));
  const warned = sized.results.find((row) => row.market === "Base" && row.symbol === "USDC");
  assert.ok(warned);
  assert.ok(warned.warnings.some((warning) => /move the rate/i.test(warning)));
  assert.ok(warned.warnings[0].includes("24.0%") || warned.warnings[0].includes("24%"));

  const noHorizon = rankAaveRates(FIXTURE, { symbols: ["GHO"], excludePermissioned: true });
  assert.equal(noHorizon.results.some((row) => row.permissioned), false);
  assert.ok(noHorizon.filtered.some((row) => /Horizon/.test(row.reason)));
  assert.ok(noHorizon.notes.some((note) => /excluded/i.test(note)));
});

test("supply ranking puts the highest usable supply APY first", () => {
  const ranked = rankAaveRates(FIXTURE, { symbols: ["USDC"], side: "supply" });
  const usable = ranked.results.filter((row) => row.suppliable);
  assert.equal(usable[0].market, "Base");
  assert.ok(usable[0].supplyApyPct > usable[1].supplyApyPct);
});

test("API failures name the problem instead of hanging", async () => {
  const url = "https://api.v3.aave.com/graphql";
  await assert.rejects(
    () => compareAaveRates({}, {
      timeoutMs: 30,
      fetch: () => new Promise(() => {}),
    }),
    /timed out after 30ms/
  );

  await assert.rejects(
    () => compareAaveRates({}, {
      fetch: async () => new Response("down", { status: 503, statusText: "Service Unavailable" }),
    }),
    /HTTP 503/
  );

  await assert.rejects(
    () => compareAaveRates({}, {
      fetch: async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }),
    /GraphQL: boom/
  );

  await assert.rejects(
    () => compareAaveRates({}, {
      fetch: async () => {
        throw new Error("socket hang up");
      },
    }),
    /not reachable: socket hang up/
  );

  const chains = {
    data: {
      chains: [
        { name: "Ethereum", chainId: 1, isTestnet: false },
        { name: "Base Sepolia", chainId: 84532, isTestnet: true },
      ],
    },
  };
  const markets = { data: { markets: FIXTURE } };
  const ok = await compareAaveRates({ symbols: ["USDC"], minLiquidityUsd: 100_000 }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const payload = body.query.includes("chains(") ? chains : markets;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  assert.equal(ok.source, url);
  assert.deepEqual(ok.chains.map((chain) => chain.chainId), [1]);
  assert.ok(ok.results.length > 0);
  assert.ok(ok.results.every((row) => row.symbol === "USDC" && row.availableLiquidityUsd >= 100_000));
  assert.equal(ok.timeoutMs, 20000);
});
