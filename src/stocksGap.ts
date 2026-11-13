/**
 * Monday-open gap model for Aave V4 Base Coinbase tokenized equities.
 *
 * Simplified health factor, matching the public risk write-up for this market:
 * collateral factor is both the borrow limit and the liquidation threshold,
 * and the V4 risk premium is not applied.
 *
 *   HF = Σ (collateralUsd × (1 + gap) × collateralFactor) / debtUsd
 *
 * Oracle prices are held from Friday 20:00 ET through Sunday 20:00 ET
 * (Chainlink 24/5 equity feeds). A gap is the jump applied when the feed
 * resumes. This is an independent model, not an Aave quote and not advice.
 */

export const STOCKS = [
  "AAPLc", "AMZNc", "GOOGLc", "METAc", "MSFTc", "NVDAc", "TSLAc", "SPCXc",
] as const;

export type StockSymbol = (typeof STOCKS)[number];

const STOCK_SET = new Set<string>(STOCKS);

export interface PositionLeg {
  user: string;
  symbol: string;
  collateralUsd?: number;
  debtUsd?: number;
}

export interface Account {
  user: string;
  collateral: Record<string, number>;
  debt: number;
}

export interface Params {
  /** Fraction, e.g. 0.65 for a 65% collateral factor. */
  collateralFactor: Record<string, number>;
  /** Fraction, informational. Not applied to the HF threshold. */
  maxLiquidationBonus: Record<string, number>;
}

export const EXAMPLE_PARAMS: Params = {
  collateralFactor: { TSLAc: 0.65, NVDAc: 0.7, AAPLc: 0.78, USDC: 0 },
  maxLiquidationBonus: { TSLAc: 0.055, NVDAc: 0.055, AAPLc: 0.055 },
};

/** Representative books used by the unit tests. Not live positions. */
export const EXAMPLE_ACCOUNTS: Account[] = [
  { user: "0x1111111111111111111111111111111111111111", collateral: { TSLAc: 1000 }, debt: 400 },
  { user: "0x2222222222222222222222222222222222222222", collateral: { TSLAc: 1000 }, debt: 640 },
  { user: "0x3333333333333333333333333333333333333333", collateral: { AAPLc: 500 }, debt: 0 },
];

export function group(legs: PositionLeg[]): Account[] {
  const map = new Map<string, Account>();
  for (const leg of legs) {
    const user = leg.user.toLowerCase();
    let account = map.get(user);
    if (!account) {
      account = { user, collateral: {}, debt: 0 };
      map.set(user, account);
    }
    if (leg.collateralUsd) {
      account.collateral[leg.symbol] = (account.collateral[leg.symbol] ?? 0) + leg.collateralUsd;
    }
    if (leg.debtUsd) account.debt += leg.debtUsd;
  }
  return [...map.values()];
}

export function hf(account: Account, params: Params, gaps: Record<string, number> = {}): number {
  let weighted = 0;
  for (const [symbol, usd] of Object.entries(account.collateral)) {
    const gap = gaps[symbol] ?? 0;
    const cf = params.collateralFactor[symbol] ?? 0;
    weighted += usd * (1 + gap) * cf;
  }
  if (!(account.debt > 0)) return Number.POSITIVE_INFINITY;
  return weighted / account.debt;
}

/**
 * Uniform gap on equity collateral that brings HF to 1.
 * Returned as a fraction (−0.10 = −10%). Null when there is no equity
 * collateral to shock or no debt.
 */
export function breakEvenGap(account: Account, params: Params): number | null {
  if (!(account.debt > 0)) return null;
  let stockW = 0;
  let otherW = 0;
  for (const [symbol, usd] of Object.entries(account.collateral)) {
    const w = usd * (params.collateralFactor[symbol] ?? 0);
    if (STOCK_SET.has(symbol)) stockW += w;
    else otherW += w;
  }
  if (stockW <= 0) return null;
  return (account.debt - otherW) / stockW - 1;
}

export interface ShockRow {
  user: string;
  debt: number;
  collateral: Record<string, number>;
  hfBefore: number;
  hfAfter: number;
  liquidatable: boolean;
  breakEvenGap: number | null;
}

export function simulateGapShock(
  accounts: Account[],
  params: Params,
  gaps: Record<string, number>,
  limit = 50
): { accounts: number; liquidatableCount: number; debtAtRisk: number; liquidatable: ShockRow[] } {
  const scored: ShockRow[] = accounts.map((account) => {
    const hfBefore = hf(account, params, {});
    const hfAfter = hf(account, params, gaps);
    return {
      user: account.user,
      debt: account.debt,
      collateral: account.collateral,
      hfBefore,
      hfAfter,
      liquidatable: Number.isFinite(hfAfter) && hfAfter < 1,
      breakEvenGap: breakEvenGap(account, params),
    };
  });
  const liquidatable = scored
    .filter((row) => row.liquidatable)
    .sort((a, b) => b.debt - a.debt);
  const debtAtRisk = liquidatable.reduce((sum, row) => sum + row.debt, 0);
  return {
    accounts: scored.length,
    liquidatableCount: liquidatable.length,
    debtAtRisk,
    liquidatable: liquidatable.slice(0, limit),
  };
}

export function gapsFromPct(gapPct: number, overrides?: Record<string, number>): Record<string, number> {
  const gaps: Record<string, number> = {};
  for (const symbol of STOCKS) {
    const pct = overrides?.[symbol] ?? gapPct;
    gaps[symbol] = pct / 100;
  }
  return gaps;
}

// --- Chainlink 24/5 session clock (America/New_York) -----------------------

const TZ = "America/New_York";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface MarketState {
  open: boolean;
  asOf: string;
  timezone: "America/New_York";
  /** Current freeze if the session is closed, otherwise the previous weekend. */
  freezeStart: string;
  freezeEnd: string;
  freezeStartSec: number;
  freezeEndSec: number;
  premise: string;
  holidayCalendar: "weekend-window-only";
}

interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function etParts(date: Date): EtParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAYS.indexOf(bag.weekday as (typeof WEEKDAYS)[number]);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    weekday,
  };
}

function tzOffsetMinutes(instant: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(Number(bag.year), Number(bag.month) - 1, Number(bag.day), hour, Number(bag.minute), Number(bag.second));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMinutes(new Date(guess));
  const utc = guess - offset * 60_000;
  const offset2 = tzOffsetMinutes(new Date(utc));
  return new Date(guess - offset2 * 60_000);
}

function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(year, month - 1, day));
  t.setUTCDate(t.getUTCDate() + days);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function isOpen(parts: EtParts): boolean {
  const mins = parts.hour * 60 + parts.minute;
  if (parts.weekday === 0) return mins >= 20 * 60;
  if (parts.weekday >= 1 && parts.weekday <= 4) return true;
  if (parts.weekday === 5) return mins < 20 * 60;
  return false;
}

/** Days from `parts` to the Friday that opened the relevant freeze (negative = earlier). */
function fridayOffset(parts: EtParts, open: boolean): number {
  if (!open) {
    if (parts.weekday === 5) return 0;
    if (parts.weekday === 6) return -1;
    return -2; // Sunday before 20:00
  }
  if (parts.weekday === 0) return -2; // Sunday at/after 20:00, that weekend's Friday
  if (parts.weekday === 5) return -7; // Friday before 20:00, the previous weekend
  return -((parts.weekday + 2) % 7); // Mon −3 … Thu −6
}

export function marketState(asOf: Date = new Date()): MarketState {
  const parts = etParts(asOf);
  const open = isOpen(parts);
  const friday = addCalendarDays(parts.year, parts.month, parts.day, fridayOffset(parts, open));
  const sunday = addCalendarDays(friday.year, friday.month, friday.day, 2);
  const start = zonedToUtc(friday.year, friday.month, friday.day, 20, 0);
  const end = zonedToUtc(sunday.year, sunday.month, sunday.day, 20, 0);
  return {
    open,
    asOf: asOf.toISOString(),
    timezone: "America/New_York",
    freezeStart: start.toISOString(),
    freezeEnd: end.toISOString(),
    freezeStartSec: Math.floor(start.getTime() / 1000),
    freezeEndSec: Math.floor(end.getTime() / 1000),
    premise: "Chainlink 24/5; last price held on weekends/holidays",
    holidayCalendar: "weekend-window-only",
  };
}
