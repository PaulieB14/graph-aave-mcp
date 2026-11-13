import { test } from "node:test";
import assert from "node:assert/strict";
import { marketState } from "../../build/stocksGap.js";

// November 2026 is EST (UTC−5). Friday 13 Nov 2026 21:00 ET = 14 Nov 02:00 UTC.
const FRI_2100_ET = new Date("2026-11-14T02:00:00Z");
// Monday 16 Nov 2026 12:00 ET = 16 Nov 17:00 UTC.
const MON_1200_ET = new Date("2026-11-16T17:00:00Z");
// Sunday 15 Nov 2026 20:00 ET = 16 Nov 01:00 UTC (session resumes).
const SUN_2000_ET = new Date("2026-11-16T01:00:00Z");
// Friday 13 Nov 2026 20:00 ET = 14 Nov 01:00 UTC (freeze starts).
const FRI_2000_ET = new Date("2026-11-14T01:00:00Z");

test("Friday 21:00 ET is inside the oracle freeze", () => {
  const state = marketState(FRI_2100_ET);
  assert.equal(state.open, false);
  assert.equal(state.timezone, "America/New_York");
  assert.ok(state.freezeStartSec <= Math.floor(FRI_2100_ET.getTime() / 1000));
  assert.ok(state.freezeEndSec > Math.floor(FRI_2100_ET.getTime() / 1000));
});

test("Monday 12:00 ET is an open equity session", () => {
  assert.equal(marketState(MON_1200_ET).open, true);
});

test("the freeze is Friday 20:00 ET inclusive and Sunday 20:00 ET exclusive", () => {
  assert.equal(marketState(FRI_2000_ET).open, false);
  assert.equal(marketState(SUN_2000_ET).open, true);
});
