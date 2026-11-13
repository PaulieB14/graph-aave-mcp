import { test } from "node:test";
import assert from "node:assert/strict";
import { marketState } from "../../build/stocksGap.js";
import { classifyFeedUpdate, EQUITY_FEEDS } from "../../build/oracleStatus.js";

test("a Saturday round is a weekend_update while the session is frozen", () => {
  const saturday = marketState(new Date("2026-11-14T18:00:00Z")); // Sat 13:00 ET
  assert.equal(saturday.open, false);
  const updatedAt = Math.floor(Date.parse("2026-11-14T18:00:00Z") / 1000);
  const flag = classifyFeedUpdate(saturday, updatedAt);
  assert.equal(flag.anomaly, "weekend_update");
  assert.equal(flag.updatedDuringFreeze, true);
});

test("the Friday close print is not treated as a weekend update", () => {
  const saturday = marketState(new Date("2026-11-14T18:00:00Z"));
  const flag = classifyFeedUpdate(saturday, saturday.freezeStartSec);
  assert.equal(flag.anomaly, null);
  assert.equal(flag.updatedDuringFreeze, false);
});

test("an open session does not flag a historical weekend print", () => {
  const monday = marketState(new Date("2026-11-16T17:00:00Z"));
  assert.equal(monday.open, true);
  const flag = classifyFeedUpdate(monday, monday.freezeStartSec + 3600);
  assert.equal(flag.anomaly, null);
  assert.equal(flag.updatedDuringFreeze, false);
});

test("the three verified Base equity feeds are present", () => {
  assert.deepEqual(EQUITY_FEEDS.map((feed) => feed.symbol), ["TSLAc", "NVDAc", "AAPLc"]);
});
