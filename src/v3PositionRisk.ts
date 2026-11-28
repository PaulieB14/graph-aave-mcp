/**
 * Live Aave V3 position risk.
 *
 * Subgraph `price.priceInEth` on V3 is an oracle snapshot and can lag the
 * real AaveOracle by a long way (cbBTC has printed ~$104k on the Ethereum
 * subgraph while the oracle was ~$61k). Health factors built from that price
 * look safer than the position actually is. This tool reads Pool,
 * AaveProtocolDataProvider, and AaveOracle at one block.
 *
 * Adding another V3 market is a row in `V3_MARKETS` (Pool, PoolDataProvider,
 * Oracle). Ethereum uses the PoolDataProvider this tool was specified with;
 * Pool and Oracle match `@aave-dao/aave-address-book`. The other rows use the
 * address book so Base, Arbitrum, and the rest of the RPC chains are the same
 * kind of entry.
 */

import {
  AaveV3Arbitrum,
  AaveV3Avalanche,
  AaveV3Base,
  AaveV3Optimism,
  AaveV3Polygon,
} from "@aave-dao/aave-address-book";
import { getAddress, parseAbi, type PublicClient } from "viem";
import { queryChain } from "./graphClient.js";
import { rayToAPY, rayToApyNumber } from "./rates.js";
import { rpcClientFor, RPC_CHAINS, rpcHint, withRpcRetry } from "./rpcClient.js";
import { CHAINS } from "./subgraphs.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const DEFAULT_SHOCKS = [5, 10, 20, 30, 50];
export const DEFAULT_TARGET_HF = 1.8;
/** Share of collateral or debt USD above which a position is single-asset. */
export const CONCENTRATION_SHARE = 0.8;
/** Supply cap utilization above this is flagged, with remaining headroom. */
export const SUPPLY_CAP_WARN = 0.95;
/**
 * Utilization above this is not a usable cap figure. Frozen leftovers and
 * unit glitches (USDbC on Base has printed tens of millions of percent) stay
 * out of the flag text.
 */
export const SUPPLY_CAP_SANE_MAX = 2;
/** User supply below this USD is dust and does not get a supply-cap flag. */
export const DUST_SUPPLY_USD = 1;
/** User supply below this share of collateral is dust. 0.001 = 0.1%. */
export const DUST_COLLATERAL_SHARE = 0.001;
/** Subgraph vs live oracle. Strictly greater than this percent warns. */
export const SUBGRAPH_DEVIATION_WARN_PCT = 2;

export interface V3Market {
  key: string;
  /** Key in `CHAINS` for the optional subgraph price check. */
  subgraphKey: string;
  pool: `0x${string}`;
  poolDataProvider: `0x${string}`;
  oracle: `0x${string}`;
}

function market(
  key: string,
  subgraphKey: string,
  pool: string,
  poolDataProvider: string,
  oracle: string
): V3Market {
  return {
    key,
    subgraphKey,
    pool: getAddress(pool),
    poolDataProvider: getAddress(poolDataProvider),
    oracle: getAddress(oracle),
  };
}

export const V3_MARKETS: Record<string, V3Market> = {
  ethereum: market(
    "ethereum",
    "ethereum",
    "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    "0x41393e5e337606dc3821075Af65AeE84D7688CBD",
    "0x54586bE62E3c3580375aE3723C145253060Ca0C2"
  ),
  base: market(
    "base",
    "base",
    AaveV3Base.POOL,
    AaveV3Base.AAVE_PROTOCOL_DATA_PROVIDER,
    AaveV3Base.ORACLE
  ),
  arbitrum: market(
    "arbitrum",
    "arbitrum",
    AaveV3Arbitrum.POOL,
    AaveV3Arbitrum.AAVE_PROTOCOL_DATA_PROVIDER,
    AaveV3Arbitrum.ORACLE
  ),
  polygon: market(
    "polygon",
    "polygon",
    AaveV3Polygon.POOL,
    AaveV3Polygon.AAVE_PROTOCOL_DATA_PROVIDER,
    AaveV3Polygon.ORACLE
  ),
  optimism: market(
    "optimism",
    "optimism",
    AaveV3Optimism.POOL,
    AaveV3Optimism.AAVE_PROTOCOL_DATA_PROVIDER,
    AaveV3Optimism.ORACLE
  ),
  avalanche: market(
    "avalanche",
    "avalanche",
    AaveV3Avalanche.POOL,
    AaveV3Avalanche.AAVE_PROTOCOL_DATA_PROVIDER,
    AaveV3Avalanche.ORACLE
  ),
};

export const V3_MARKET_NAMES = Object.keys(V3_MARKETS) as [string, ...string[]];

const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "USDt", "DAI", "GHO", "USDE", "USDS", "LUSD", "FRAX", "CRVUSD",
  "PYUSD", "USDBC", "TUSD", "BUSD", "USDP", "GUSD", "SUSD", "USDT0", "RLUSD",
  "AUSD", "USDG", "USDtb", "EURC", "EURS", "AGEUR", "EUROC", "USDCE", "USDB",
  "MIM", "DOLA", "USDM",
]);

export interface CollateralLeg {
  id: string;
  symbol: string;
  /** Token amount. */
  amount: number;
  usd: number;
  priceUsd: number;
  /** Fraction, 1 = 100%. */
  ltv: number;
  liquidationThreshold: number;
  isStable: boolean;
  usageAsCollateralEnabled: boolean;
}

export interface DebtLeg {
  id: string;
  symbol: string;
  amount: number;
  usd: number;
  priceUsd: number;
}

export interface MarketStatus {
  id: string;
  symbol: string;
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  /** Whole tokens. 0 means no cap. */
  supplyCapTokens: number;
  suppliedTokens: number;
  priceUsd: number;
}

export interface RiskFlag {
  code:
    | "liquidatable"
    | "zero_ltv_collateral"
    | "frozen_reserve"
    | "paused_reserve"
    | "inactive_reserve"
    | "supply_cap"
    | "concentration"
    | "subgraph_price_deviation"
    | "valuation_divergence";
  severity: "info" | "warning" | "critical";
  asset?: string;
  message: string;
}

export interface EModeInput {
  categoryId: number;
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  /** Lowercase, or the zero address when liquid e-mode has no custom source. */
  priceSource: string;
  collateralBitmap: bigint;
  borrowableBitmap: bigint;
  ltvzeroBitmap: bigint;
  isolated: boolean;
}

export function bitmapHas(bitmap: bigint, index: number): boolean {
  if (index < 0 || index > 127) return false;
  return (bitmap & (1n << BigInt(index))) !== 0n;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/₮/g, "T").replace(/[^A-Z0-9]/g, "");
}

/**
 * USD stables (and EUR stables on the symbol list) are not part of a joint
 * crypto drop. A tight $1 band catches listings that are not in the set yet.
 */
export function isStableAsset(symbol: string, priceUsd: number): boolean {
  if (STABLE_SYMBOLS.has(normalizeSymbol(symbol))) return true;
  return Number.isFinite(priceUsd) && priceUsd >= 0.97 && priceUsd <= 1.03;
}

export function unitDecimals(unit: bigint): number {
  if (unit <= 0n) return 0;
  let decimals = 0;
  let rest = unit;
  while (rest % 10n === 0n) {
    rest /= 10n;
    decimals += 1;
  }
  if (rest !== 1n) {
    throw new Error(`Base currency unit ${unit.toString()} is not a power of 10`);
  }
  return decimals;
}

/** Bigint scaled by `decimals` → number, keeping 12 fractional digits. */
export function scaledToNumber(value: bigint, decimals: number): number {
  if (value === 0n) return 0;
  const neg = value < 0n;
  let abs = neg ? -value : value;
  let digits = decimals;
  if (digits > 12) {
    const div = 10n ** BigInt(digits - 12);
    abs = (abs + div / 2n) / div;
    digits = 12;
  }
  const base = 10n ** BigInt(Math.max(digits, 0));
  const whole = abs / base;
  const frac = abs % base;
  const n = Number(whole) + (digits > 0 ? Number(frac) / 10 ** digits : 0);
  return neg ? -n : n;
}

export function tokenValueUsd(
  amountRaw: bigint,
  tokenDecimals: number,
  priceRaw: bigint,
  baseUnit: bigint
): number {
  if (amountRaw <= 0n || priceRaw <= 0n || baseUnit <= 0n) return 0;
  const scale = 10n ** BigInt(tokenDecimals);
  const baseRaw = (amountRaw * priceRaw) / scale;
  return scaledToNumber(baseRaw, unitDecimals(baseUnit));
}

export function formatTokenAmount(amountRaw: bigint, decimals: number, maxFrac = 8): string {
  const neg = amountRaw < 0n;
  let abs = neg ? -amountRaw : amountRaw;
  const fracDigits = Math.max(0, Math.min(decimals, maxFrac));
  if (decimals > fracDigits) {
    const div = 10n ** BigInt(decimals - fracDigits);
    abs = (abs + div / 2n) / div;
  }
  const base = 10n ** BigInt(fracDigits);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = fracDigits > 0 ? frac.toString().padStart(fracDigits, "0").replace(/0+$/, "") : "";
  const out = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

/**
 * Effective LTV / liquidation threshold for one reserve.
 *
 * Matches `ValidationLogic.getUserReserveLtv` and `GenericLogic`: e-mode LT
 * applies only to reserves on the category collateral bitmap. LTV is the
 * category LTV there, unless the ltvzero bitmap (or an isolated category for
 * an asset outside the bitmap) forces LTV 0. A non-zero legacy price source
 * replaces the asset oracle for reserves on the collateral or borrowable bitmap.
 * Liquid e-modes return the zero address, and the asset oracle is used.
 */
export function effectiveReserveRisk(args: {
  reserveIndex: number;
  ltvBps: number;
  liquidationThresholdBps: number;
  priceUsd: number;
  eMode: EModeInput | null;
  priceSourceUsd: number | null;
}): {
  ltvBps: number;
  liquidationThresholdBps: number;
  priceUsd: number;
  inEMode: boolean;
  usedPriceSource: boolean;
} {
  const eMode = args.eMode;
  if (!eMode || eMode.categoryId === 0) {
    return {
      ltvBps: args.ltvBps,
      liquidationThresholdBps: args.liquidationThresholdBps,
      priceUsd: args.priceUsd,
      inEMode: false,
      usedPriceSource: false,
    };
  }
  const onCollateral = bitmapHas(eMode.collateralBitmap, args.reserveIndex);
  const onBorrowable = bitmapHas(eMode.borrowableBitmap, args.reserveIndex);
  const onLtvZero = bitmapHas(eMode.ltvzeroBitmap, args.reserveIndex);
  let ltvBps = args.ltvBps;
  let liquidationThresholdBps = args.liquidationThresholdBps;
  if (onCollateral) {
    liquidationThresholdBps = eMode.liquidationThresholdBps;
    ltvBps = onLtvZero ? 0 : eMode.ltvBps;
  } else if (eMode.isolated) {
    ltvBps = 0;
  }
  const source = eMode.priceSource.toLowerCase();
  const usedPriceSource =
    source !== ZERO_ADDRESS &&
    (onCollateral || onBorrowable) &&
    args.priceSourceUsd != null &&
    args.priceSourceUsd > 0;
  return {
    ltvBps,
    liquidationThresholdBps,
    priceUsd: usedPriceSource ? args.priceSourceUsd! : args.priceUsd,
    inEMode: onCollateral,
    usedPriceSource,
  };
}

function round(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function weightedCollateralUsd(legs: CollateralLeg[]): number {
  let sum = 0;
  for (const leg of legs) {
    if (!leg.usageAsCollateralEnabled) continue;
    sum += leg.usd * leg.liquidationThreshold;
  }
  return sum;
}

export function totalDebtUsd(legs: DebtLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.usd, 0);
}

export function enabledCollateralUsd(legs: CollateralLeg[]): number {
  return legs.reduce((sum, leg) => sum + (leg.usageAsCollateralEnabled ? leg.usd : 0), 0);
}

export function healthFactorFromBook(collateral: CollateralLeg[], debt: DebtLeg[]): number {
  const debtUsd = totalDebtUsd(debt);
  if (!(debtUsd > 0)) return Number.POSITIVE_INFINITY;
  return weightedCollateralUsd(collateral) / debtUsd;
}

function dropLegs(legs: CollateralLeg[], dropFraction: number): CollateralLeg[] {
  const keep = 1 - dropFraction;
  return legs.map((leg) => {
    if (leg.isStable) return leg;
    return { ...leg, usd: leg.usd * keep, priceUsd: leg.priceUsd * keep };
  });
}

export function healthFactorAfterDrop(
  collateral: CollateralLeg[],
  debtUsd: number,
  dropPct: number
): { healthFactor: number; collateralUsd: number } {
  const dropped = dropLegs(collateral, dropPct / 100);
  return {
    healthFactor: debtUsd > 0 ? weightedCollateralUsd(dropped) / debtUsd : Number.POSITIVE_INFINITY,
    collateralUsd: enabledCollateralUsd(dropped),
  };
}

export function jointDropToHf1(
  collateral: CollateralLeg[],
  debtUsd: number
): { dropPct: number | null; reason: string | null } {
  if (!(debtUsd > 0)) return { dropPct: null, reason: "no debt" };
  let stableW = 0;
  let nonStableW = 0;
  for (const leg of collateral) {
    if (!leg.usageAsCollateralEnabled) continue;
    const weighted = leg.usd * leg.liquidationThreshold;
    if (leg.isStable) stableW += weighted;
    else nonStableW += weighted;
  }
  if (!(nonStableW > 0)) {
    return {
      dropPct: null,
      reason:
        stableW >= debtUsd
          ? "no non-stable collateral; stable collateral keeps health factor above 1"
          : "no non-stable collateral",
    };
  }
  const drop = 1 - (debtUsd - stableW) / nonStableW;
  if (drop <= 0) return { dropPct: 0, reason: "health factor is already at or below 1" };
  if (drop > 1) {
    return {
      dropPct: null,
      reason: "health factor stays above 1 even if every non-stable collateral price goes to 0",
    };
  }
  return { dropPct: drop * 100, reason: null };
}

export function priceAtHf1(
  asset: CollateralLeg,
  collateral: CollateralLeg[],
  debt: DebtLeg[]
): { status: "price" | "cannot liquidate alone"; priceUsd: number | null; dropPct: number | null } {
  if (!asset.usageAsCollateralEnabled) {
    return { status: "cannot liquidate alone", priceUsd: null, dropPct: null };
  }
  let otherW = 0;
  for (const leg of collateral) {
    if (leg.id === asset.id || !leg.usageAsCollateralEnabled) continue;
    otherW += leg.usd * leg.liquidationThreshold;
  }
  let otherD = 0;
  let thisDebt = 0;
  for (const leg of debt) {
    if (leg.id === asset.id) thisDebt += leg.usd;
    else otherD += leg.usd;
  }
  const thisW = asset.usd * asset.liquidationThreshold;
  const hfAtZero = otherD > 0 ? otherW / otherD : Number.POSITIVE_INFINITY;
  // "cannot liquidate alone" is the case the position stays healthy at price 0.
  if (hfAtZero > 1) {
    return { status: "cannot liquidate alone", priceUsd: null, dropPct: null };
  }
  const denom = thisW - thisDebt;
  if (denom === 0 || !(asset.priceUsd > 0)) {
    return { status: "price", priceUsd: 0, dropPct: 100 };
  }
  const multiplier = (otherD - otherW) / denom;
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    return { status: "cannot liquidate alone", priceUsd: null, dropPct: null };
  }
  return {
    status: "price",
    priceUsd: asset.priceUsd * multiplier,
    dropPct: (1 - multiplier) * 100,
  };
}

function blocksOtherWithdrawals(collateral: CollateralLeg[]): boolean {
  return collateral.some(
    (leg) => leg.usageAsCollateralEnabled && leg.amount > 0 && leg.usd > 0 && leg.ltv === 0
  );
}

export interface BookAnalysis {
  healthFactor: number;
  collateralUsd: number;
  debtUsd: number;
  weightedCollateralUsd: number;
  shocks: { dropPct: number; healthFactor: number; collateralUsd: number }[];
  jointDropToHealthFactor1: { dropPct: number | null; reason: string | null };
  perAssetPriceAtHealthFactor1: {
    id: string;
    symbol: string;
    status: "price" | "cannot liquidate alone";
    currentPriceUsd: number;
    priceUsdAtHf1: number | null;
    dropPctAtHf1: number | null;
  }[];
  targetHealthFactor: number;
  alreadyAboveTarget: boolean;
  repayUsd: number;
  repay: { id: string; symbol: string; amount: number; usd: number; exceedsBalance: boolean }[];
  collateralAddUsd: number | null;
  collateralAdd: { id: string; symbol: string; amount: number | null; usd: number | null; note: string | null }[];
  extraBorrowUsd: number;
  withdrawable: { id: string; symbol: string; amount: number; usd: number; blocked: boolean; note: string | null }[];
}

export function analyzeBook(args: {
  collateral: CollateralLeg[];
  debt: DebtLeg[];
  shocks: number[];
  targetHealthFactor: number;
}): BookAnalysis {
  const { collateral, debt, shocks, targetHealthFactor } = args;
  const debtUsd = totalDebtUsd(debt);
  const collateralUsd = enabledCollateralUsd(collateral);
  const weighted = weightedCollateralUsd(collateral);
  const healthFactor = debtUsd > 0 ? weighted / debtUsd : Number.POSITIVE_INFINITY;
  const alreadyAboveTarget = !(debtUsd > 0) || healthFactor >= targetHealthFactor;
  const repayUsd = alreadyAboveTarget ? 0 : debtUsd - weighted / targetHealthFactor;
  const deficitWeighted = targetHealthFactor * debtUsd - weighted;
  const weightedLt = collateralUsd > 0 ? weighted / collateralUsd : 0;
  const collateralAddUsd =
    deficitWeighted <= 0 ? 0 : weightedLt > 0 ? deficitWeighted / weightedLt : null;
  const blocked = blocksOtherWithdrawals(collateral);
  const surplus = weighted - targetHealthFactor * debtUsd;

  return {
    healthFactor,
    collateralUsd,
    debtUsd,
    weightedCollateralUsd: weighted,
    shocks: shocks.map((dropPct) => {
      const after = healthFactorAfterDrop(collateral, debtUsd, dropPct);
      return { dropPct, healthFactor: after.healthFactor, collateralUsd: after.collateralUsd };
    }),
    jointDropToHealthFactor1: jointDropToHf1(collateral, debtUsd),
    perAssetPriceAtHealthFactor1: collateral
      .filter((leg) => leg.usageAsCollateralEnabled && (leg.amount > 0 || leg.usd > 0))
      .map((leg) => {
        const hit = priceAtHf1(leg, collateral, debt);
        return {
          id: leg.id,
          symbol: leg.symbol,
          status: hit.status,
          currentPriceUsd: leg.priceUsd,
          priceUsdAtHf1: hit.priceUsd,
          dropPctAtHf1: hit.dropPct,
        };
      }),
    targetHealthFactor,
    alreadyAboveTarget,
    repayUsd,
    repay: debt.map((leg) => {
      if (repayUsd <= 0) {
        return { id: leg.id, symbol: leg.symbol, amount: 0, usd: 0, exceedsBalance: false };
      }
      const amount = leg.priceUsd > 0 ? repayUsd / leg.priceUsd : 0;
      return {
        id: leg.id,
        symbol: leg.symbol,
        amount,
        usd: repayUsd,
        exceedsBalance: amount > leg.amount + 1e-9,
      };
    }),
    collateralAddUsd,
    collateralAdd: collateral.map((leg) => {
      if (deficitWeighted <= 0) {
        return { id: leg.id, symbol: leg.symbol, amount: 0, usd: 0, note: null };
      }
      if (!(leg.liquidationThreshold > 0) || !(leg.priceUsd > 0)) {
        return {
          id: leg.id,
          symbol: leg.symbol,
          amount: null,
          usd: null,
          note: "Liquidation threshold is 0, so adding this asset does not raise health factor.",
        };
      }
      const usd = deficitWeighted / leg.liquidationThreshold;
      return { id: leg.id, symbol: leg.symbol, amount: usd / leg.priceUsd, usd, note: null };
    }),
    extraBorrowUsd: Math.max(0, weighted / targetHealthFactor - debtUsd),
    withdrawable: collateral.map((leg) => {
      if (!leg.usageAsCollateralEnabled || surplus <= 0) {
        return { id: leg.id, symbol: leg.symbol, amount: 0, usd: 0, blocked: false, note: null };
      }
      if (blocked && leg.ltv !== 0) {
        return {
          id: leg.id,
          symbol: leg.symbol,
          amount: 0,
          usd: 0,
          blocked: true,
          note:
            "Blocked while an LTV-0 asset is enabled as collateral. That asset has to be withdrawn or disabled first.",
        };
      }
      if (!(leg.liquidationThreshold > 0) || !(leg.priceUsd > 0)) {
        return {
          id: leg.id,
          symbol: leg.symbol,
          amount: leg.amount,
          usd: leg.usd,
          blocked: false,
          note: "Liquidation threshold is 0, so withdrawing this asset does not change health factor.",
        };
      }
      const usd = Math.min(leg.usd, surplus / leg.liquidationThreshold);
      const amount = Math.min(leg.amount, usd / leg.priceUsd);
      return { id: leg.id, symbol: leg.symbol, amount, usd: Math.min(leg.usd, amount * leg.priceUsd), blocked: false, note: null };
    }),
  };
}

export function priceDeviationPct(oracleUsd: number, subgraphUsd: number): number | null {
  if (!(oracleUsd > 0) || !Number.isFinite(subgraphUsd)) return null;
  return (Math.abs(subgraphUsd - oracleUsd) / oracleUsd) * 100;
}

export function positionRiskFlags(args: {
  collateral: CollateralLeg[];
  debt: DebtLeg[];
  markets: MarketStatus[];
  healthFactor: number;
  healthFactorFromLegs: number;
  deviations?: { symbol: string; oracleUsd: number; subgraphUsd: number; deviationPct: number }[];
}): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const hf = args.healthFactor;
  if (Number.isFinite(hf) && hf < 1) {
    flags.push({
      code: "liquidatable",
      severity: "critical",
      message: `Health factor ${hf.toFixed(4)} is below 1. This position can be liquidated at the current oracle prices.`,
    });
  }
  if (
    Number.isFinite(hf) &&
    Number.isFinite(args.healthFactorFromLegs) &&
    Math.abs(hf - args.healthFactorFromLegs) > 0.02
  ) {
    flags.push({
      code: "valuation_divergence",
      severity: "warning",
      message:
        `Per-asset oracle health factor ${args.healthFactorFromLegs.toFixed(4)} differs from ` +
        `Pool.getUserAccountData ${hf.toFixed(4)}. Scenarios use the per-asset valuation.`,
    });
  }
  for (const leg of args.collateral) {
    if (!leg.usageAsCollateralEnabled || !(leg.amount > 0) || leg.ltv !== 0) continue;
    flags.push({
      code: "zero_ltv_collateral",
      severity: "warning",
      asset: leg.symbol,
      message:
        `${leg.symbol} is enabled as collateral with LTV 0. It counts toward the health factor ` +
        `(liquidation threshold ${(leg.liquidationThreshold * 100).toFixed(2)}%) but adds no borrow power, ` +
        `and it restricts withdrawing other collateral until it is withdrawn or disabled as collateral.`,
    });
  }
  for (const market of args.markets) {
    if (!market.isActive) {
      flags.push({
        code: "inactive_reserve",
        severity: "warning",
        asset: market.symbol,
        message: `${market.symbol} is inactive.`,
      });
    }
    if (market.isPaused) {
      flags.push({
        code: "paused_reserve",
        severity: "warning",
        asset: market.symbol,
        message: `${market.symbol} is paused. Supply, borrow, withdraw, repay, and liquidation are blocked on this reserve.`,
      });
    }
    if (market.isFrozen) {
      flags.push({
        code: "frozen_reserve",
        severity: "warning",
        asset: market.symbol,
        message: `${market.symbol} is frozen. New supply and new borrows are blocked.`,
      });
    }
    // Frozen reserves already say frozen. A cap percent on top of that is how
    // USDbC on Base printed "13,454,213% full". Dust balances are the same
    // kind of noise: the user cannot add size there.
    if (!market.isFrozen && market.supplyCapTokens > 0 && market.suppliedTokens > 0) {
      const used = market.suppliedTokens / market.supplyCapTokens;
      const userUsd = userSupplyUsd(market, args.collateral);
      const collateralUsd = args.collateral.reduce((sum, leg) => sum + Math.max(0, leg.usd), 0);
      const dust =
        userUsd < DUST_SUPPLY_USD ||
        (collateralUsd > 0 && userUsd / collateralUsd < DUST_COLLATERAL_SHARE);
      if (Number.isFinite(used) && used > SUPPLY_CAP_WARN && used <= SUPPLY_CAP_SANE_MAX && !dust) {
        const headroom = market.supplyCapTokens - market.suppliedTokens;
        const headroomUsd = headroom > 0 && market.priceUsd > 0 ? headroom * market.priceUsd : null;
        const headroomText =
          headroom > 0
            ? `Headroom remaining: ${round(headroom, 4)} ${market.symbol}` +
              (headroomUsd == null ? "." : ` (about $${round(headroomUsd, 2).toLocaleString("en-US")}).`)
            : "No supply-cap headroom remaining.";
        flags.push({
          code: "supply_cap",
          severity: "warning",
          asset: market.symbol,
          message: `${market.symbol} supply cap is ${(used * 100).toFixed(2)}% full. ${headroomText}`,
        });
      }
    }
  }
  const colUsd = enabledCollateralUsd(args.collateral);
  if (colUsd > 0) {
    let top: CollateralLeg | null = null;
    for (const leg of args.collateral) {
      if (!leg.usageAsCollateralEnabled) continue;
      if (!top || leg.usd > top.usd) top = leg;
    }
    if (top && top.usd / colUsd >= CONCENTRATION_SHARE) {
      flags.push({
        code: "concentration",
        severity: "warning",
        asset: top.symbol,
        message:
          `${top.symbol} is ${((top.usd / colUsd) * 100).toFixed(1)}% of collateral. ` +
          `A price move in this asset dominates liquidation risk.`,
      });
    }
  }
  const debtUsd = totalDebtUsd(args.debt);
  if (debtUsd > 0) {
    let top: DebtLeg | null = null;
    for (const leg of args.debt) {
      if (!top || leg.usd > top.usd) top = leg;
    }
    if (top && top.usd / debtUsd >= CONCENTRATION_SHARE) {
      flags.push({
        code: "concentration",
        severity: "info",
        asset: top.symbol,
        message: `${top.symbol} is ${((top.usd / debtUsd) * 100).toFixed(1)}% of debt.`,
      });
    }
  }
  for (const row of args.deviations ?? []) {
    if (row.deviationPct > SUBGRAPH_DEVIATION_WARN_PCT) {
      flags.push({
        code: "subgraph_price_deviation",
        severity: "warning",
        asset: row.symbol,
        message:
          `${row.symbol} live oracle is $${round(row.oracleUsd, 2).toLocaleString("en-US")} vs subgraph ` +
          `$${round(row.subgraphUsd, 2).toLocaleString("en-US")} (${row.deviationPct.toFixed(2)}% deviation). ` +
          `Health factor here uses the live oracle.`,
      });
    }
  }
  return flags;
}

function userSupplyUsd(market: MarketStatus, collateral: CollateralLeg[]): number {
  const id = market.id.toLowerCase();
  const byId = collateral.find((leg) => leg.id.toLowerCase() === id);
  if (byId) return byId.usd;
  const bySymbol = collateral.find((leg) => leg.symbol === market.symbol);
  return bySymbol?.usd ?? 0;
}

/**
 * Reject a malformed address before any RPC call. viem's checksum error is
 * rewritten so callers do not append the "Tried N RPC endpoint(s)" hint.
 */
export function parseUserAddress(input: string): `0x${string}` {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`Invalid address: "${input}". Expected a 0x-prefixed 20-byte hex address.`);
  }
  try {
    return getAddress(raw);
  } catch {
    throw new Error(`Invalid address: "${input}". Expected a 0x-prefixed 20-byte hex address.`);
  }
}

export function positionSummary(args: {
  chain: string;
  blockNumber: string;
  healthFactorText: string;
  collateral: { amount: string; symbol: string; usd: number }[];
  debt: { amount: string; symbol: string; usd: number }[];
  jointDropPct: number | null;
  jointDropReason: string | null;
  cannotLiquidateAlone: string[];
}): string {
  if (args.collateral.length === 0 && args.debt.length === 0) {
    return (
      `No open position on ${args.chain} at block ${args.blockNumber}. ` +
      `This wallet has no supplies and no debt.`
    );
  }
  const colText =
    args.collateral
      .map((row) => `${row.amount} ${row.symbol} ($${row.usd.toLocaleString("en-US")})`)
      .join(" + ") || "none";
  const debtText =
    args.debt
      .map((row) => `${row.amount} ${row.symbol} ($${row.usd.toLocaleString("en-US")})`)
      .join(" + ") || "none";
  const dropText =
    args.jointDropPct == null
      ? `Joint non-stable drop to HF 1: ${args.jointDropReason}. `
      : `Joint non-stable drop to HF 1: ${args.jointDropPct.toFixed(2)}%. `;
  const aloneText =
    args.collateral.length === 0
      ? "No collateral is supplied."
      : args.cannotLiquidateAlone.length
        ? `${args.cannotLiquidateAlone.join(", ")} cannot liquidate alone.`
        : "Every collateral asset can reach HF 1 on its own.";
  return (
    `HF ${args.healthFactorText} on ${args.chain} at block ${args.blockNumber}. ` +
    `Collateral ${colText}. Debt ${debtText}. ${dropText}${aloneText}`
  );
}

/** Address errors stay address errors. Other failures still get the RPC hint. */
export function positionRiskError(chain: string, error: unknown): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  if (/invalid address/i.test(e.message)) return e;
  if (!/RPC endpoint/i.test(e.message)) e.message = e.message + rpcHint(chain);
  return e;
}

// ── Chain reads ─────────────────────────────────────────────────────────────

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserEMode(address user) view returns (uint256)",
  "function getReservesList() view returns (address[])",
  "function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))",
  "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)",
  "function getEModeCategoryBorrowableBitmap(uint8 id) view returns (uint128)",
  "function getEModeCategoryLtvzeroBitmap(uint8 id) view returns (uint128)",
  "function getIsEModeCategoryIsolated(uint8 id) view returns (bool)",
]);

const DATA_PROVIDER_ABI = parseAbi([
  "function getAllReservesTokens() view returns ((string symbol, address tokenAddress)[])",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveCaps(address asset) view returns (uint256 borrowCap, uint256 supplyCap)",
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
  "function getPaused(address asset) view returns (bool)",
  "function getATokenTotalSupply(address asset) view returns (uint256)",
  "function getTotalDebt(address asset) view returns (uint256)",
]);

const ORACLE_ABI = parseAbi([
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
]);

interface ActiveReserve {
  index: number;
  address: `0x${string}`;
  symbol: string;
  suppliedRaw: bigint;
  stableDebtRaw: bigint;
  variableDebtRaw: bigint;
  userStableBorrowRate: bigint;
  usageAsCollateralEnabled: boolean;
}

function tuple(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value as object);
  throw new Error("Expected a contract tuple");
}

function asBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  throw new Error(`Expected a uint, got ${typeof value}`);
}

function asBool(value: unknown): boolean {
  return Boolean(value);
}

function asAddress(value: unknown): `0x${string}` {
  return getAddress(String(value));
}

type Call = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

async function multicallChunked(
  client: PublicClient,
  calls: Call[],
  blockNumber: bigint,
  size = 20
): Promise<({ status: "success"; result: unknown } | { status: "failure" })[]> {
  const out: ({ status: "success"; result: unknown } | { status: "failure" })[] = [];
  for (let i = 0; i < calls.length; i += size) {
    const slice = calls.slice(i, i + size);
    const part = (await client.multicall({
      contracts: slice as never[],
      allowFailure: true,
      blockNumber,
    })) as readonly ({ status: "success"; result: unknown } | { status: "failure" })[];
    for (const row of part) {
      out.push(
        row.status === "success"
          ? { status: "success", result: row.result }
          : { status: "failure" }
      );
    }
  }
  return out;
}

function hfExact(raw: bigint): { text: string; value: number | "infinity" } {
  const max = 2n ** 256n - 1n;
  if (raw === max) return { text: "infinity", value: "infinity" };
  return { text: formatTokenAmount(raw, 18, 8), value: scaledToNumber(raw, 18) };
}

function rpcSource(chainKey: string, rpcUrl?: string): "override" | "env" | "public-fallback" {
  if (rpcUrl) return "override";
  const cfg = RPC_CHAINS[chainKey];
  if (cfg && process.env[cfg.rpcEnvVar]) return "env";
  return "public-fallback";
}

function jsonHf(value: number): number | "infinity" {
  return Number.isFinite(value) ? round(value, 6) : "infinity";
}

function jsonUsd(value: number): number {
  return round(value, 2);
}

function jsonToken(value: number): number {
  return round(value, 8);
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function bpsPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

interface SubgraphCheck {
  status: "ok" | "warning" | "skipped";
  thresholdPct: number;
  reason?: string;
  assets: {
    symbol: string;
    underlying: string;
    oracleUsd: number;
    subgraphUsd: number | null;
    deviationPct: number | null;
    warning: boolean;
  }[];
}

async function compareSubgraphPrices(
  subgraphKey: string,
  assets: { symbol: string; underlying: string; priceUsd: number }[]
): Promise<SubgraphCheck> {
  const thresholdPct = SUBGRAPH_DEVIATION_WARN_PCT;
  if (!process.env.GRAPH_API_KEY) {
    return {
      status: "skipped",
      thresholdPct,
      reason: "GRAPH_API_KEY is not set, so subgraph prices were not compared.",
      assets: [],
    };
  }
  const cfg = CHAINS[subgraphKey];
  if (!cfg || cfg.version !== "v3") {
    return {
      status: "skipped",
      thresholdPct,
      reason: `No V3 subgraph configured for ${subgraphKey}.`,
      assets: [],
    };
  }
  if (assets.length === 0) {
    return { status: "ok", thresholdPct, assets: [] };
  }
  const ids = assets.map((asset) => asset.underlying.toLowerCase());
  const query = `{
    reserves(first: ${ids.length}, where: { underlyingAsset_in: [${ids.map((id) => `"${id}"`).join(", ")}] }) {
      symbol
      underlyingAsset
      price { priceInEth }
    }
  }`;
  try {
    const data = (await queryChain(cfg.subgraphId, query)) as {
      reserves?: { symbol: string; underlyingAsset: string; price?: { priceInEth?: string } }[];
    };
    const byAddress = new Map<string, number>();
    for (const row of data?.reserves ?? []) {
      const raw = row.price?.priceInEth;
      if (raw == null) continue;
      byAddress.set(row.underlyingAsset.toLowerCase(), Number(raw) / 1e8);
    }
    const compared = assets.map((asset) => {
      const subgraphUsd = byAddress.get(asset.underlying.toLowerCase()) ?? null;
      const deviationPct =
        subgraphUsd == null ? null : priceDeviationPct(asset.priceUsd, subgraphUsd);
      return {
        symbol: asset.symbol,
        underlying: asset.underlying,
        oracleUsd: round(asset.priceUsd, 8),
        subgraphUsd: subgraphUsd == null ? null : round(subgraphUsd, 8),
        deviationPct: deviationPct == null ? null : round(deviationPct, 4),
        warning: deviationPct != null && deviationPct > thresholdPct,
      };
    });
    const warning = compared.some((row) => row.warning);
    return { status: warning ? "warning" : "ok", thresholdPct, assets: compared };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "skipped",
      thresholdPct,
      reason: `Subgraph price check failed: ${message}`,
      assets: [],
    };
  }
}

export interface PositionRiskInput {
  chain: string;
  userAddress: string;
  shocks?: number[];
  targetHealthFactor?: number;
  rpcUrl?: string;
}

export async function getV3PositionRisk(input: PositionRiskInput) {
  const user = parseUserAddress(input.userAddress);
  const chain = input.chain.toLowerCase();
  const marketCfg = V3_MARKETS[chain];
  if (!marketCfg) {
    throw new Error(
      `No V3 market config for ${input.chain}. Supported: ${V3_MARKET_NAMES.join(", ")}`
    );
  }
  const shocks = input.shocks ?? DEFAULT_SHOCKS;
  for (const shock of shocks) {
    if (!Number.isFinite(shock) || shock < 0 || shock > 100) {
      throw new Error(`Shock ${shock} is outside 0–100 percent`);
    }
  }
  const targetHealthFactor = input.targetHealthFactor ?? DEFAULT_TARGET_HF;
  if (!(targetHealthFactor > 0)) {
    throw new Error("targetHealthFactor must be positive");
  }
  const rpcUrl = input.rpcUrl?.trim() || undefined;

  return withRpcRetry(chain, async () => {
    const client = rpcClientFor(chain, rpcUrl);
    const block = await client.getBlock();
    const blockNumber = block.number;
    const read = <T,>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) =>
      client.readContract({
        address,
        abi: abi as never,
        functionName,
        args,
        blockNumber,
      } as never) as Promise<T>;

    const [accountRaw, eModeRaw, reserves, tokenRows] = await Promise.all([
      read<readonly bigint[]>(marketCfg.pool, POOL_ABI, "getUserAccountData", [user]),
      read<bigint>(marketCfg.pool, POOL_ABI, "getUserEMode", [user]),
      read<readonly `0x${string}`[]>(marketCfg.pool, POOL_ABI, "getReservesList"),
      read<{ symbol: string; tokenAddress: `0x${string}` }[]>(
        marketCfg.poolDataProvider,
        DATA_PROVIDER_ABI,
        "getAllReservesTokens"
      ).catch(() => [] as { symbol: string; tokenAddress: `0x${string}` }[]),
    ]);

    const symbols = new Map<string, string>();
    tokenRows.forEach((row, index) => {
      const values = tuple(row);
      const symbol = String(values[0] ?? "");
      const addr = asAddress(values[1] ?? reserves[index]);
      if (symbol) symbols.set(addr.toLowerCase(), symbol);
    });

    const userCalls: Call[] = reserves.map((asset) => ({
      address: marketCfg.poolDataProvider,
      abi: DATA_PROVIDER_ABI,
      functionName: "getUserReserveData",
      args: [asset, user],
    }));
    const userRows = await multicallChunked(client, userCalls, blockNumber);
    const active: ActiveReserve[] = [];
    reserves.forEach((asset, index) => {
      const row = userRows[index];
      if (!row || row.status !== "success") return;
      const values = tuple(row.result);
      const suppliedRaw = asBig(values[0]);
      const stableDebtRaw = asBig(values[1]);
      const variableDebtRaw = asBig(values[2]);
      if (suppliedRaw === 0n && stableDebtRaw === 0n && variableDebtRaw === 0n) return;
      const address = getAddress(asset);
      active.push({
        index,
        address,
        symbol: symbols.get(address.toLowerCase()) ?? `${address.slice(0, 6)}…${address.slice(-4)}`,
        suppliedRaw,
        stableDebtRaw,
        variableDebtRaw,
        userStableBorrowRate: asBig(values[5]),
        usageAsCollateralEnabled: asBool(values[8]),
      });
    });

    const categoryId = Number(eModeRaw);
    let eMode: EModeInput | null = null;
    let eModeLabel: string | null = null;
    if (categoryId !== 0) {
      if (categoryId > 255) {
        throw new Error(`User e-mode category ${categoryId} does not fit the uint8 getters`);
      }
      const id = categoryId as number;
      const [legacy, collateralBitmap, borrowableBitmap, ltvzeroBitmap, isolatedRow] = await Promise.all([
        read<unknown>(marketCfg.pool, POOL_ABI, "getEModeCategoryData", [id]),
        read<bigint>(marketCfg.pool, POOL_ABI, "getEModeCategoryCollateralBitmap", [id]),
        read<bigint>(marketCfg.pool, POOL_ABI, "getEModeCategoryBorrowableBitmap", [id]).catch(() => 0n),
        read<bigint>(marketCfg.pool, POOL_ABI, "getEModeCategoryLtvzeroBitmap", [id]).catch(() => 0n),
        read<boolean>(marketCfg.pool, POOL_ABI, "getIsEModeCategoryIsolated", [id]).catch(() => false),
      ]);
      const values = tuple(legacy);
      eModeLabel = String(values[4] ?? "") || null;
      eMode = {
        categoryId,
        ltvBps: Number(asBig(values[0])),
        liquidationThresholdBps: Number(asBig(values[1])),
        liquidationBonusBps: Number(asBig(values[2])),
        priceSource: asAddress(values[3]).toLowerCase(),
        collateralBitmap,
        borrowableBitmap,
        ltvzeroBitmap,
        isolated: Boolean(isolatedRow),
      };
    }

    const detailCalls: Call[] = [];
    for (const reserve of active) {
      const asset = reserve.address;
      detailCalls.push(
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveConfigurationData", args: [asset] },
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveCaps", args: [asset] },
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveData", args: [asset] },
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getPaused", args: [asset] },
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getATokenTotalSupply", args: [asset] },
        { address: marketCfg.poolDataProvider, abi: DATA_PROVIDER_ABI, functionName: "getTotalDebt", args: [asset] }
      );
    }
    const detail = detailCalls.length ? await multicallChunked(client, detailCalls, blockNumber, 24) : [];

    const priceAssets = active.map((reserve) => reserve.address);
    let priceSourceUsd: number | null = null;
    const baseUnit = await read<bigint>(marketCfg.oracle, ORACLE_ABI, "BASE_CURRENCY_UNIT");
    const prices = priceAssets.length
      ? await read<readonly bigint[]>(marketCfg.oracle, ORACLE_ABI, "getAssetsPrices", [priceAssets])
      : [];
    if (eMode && eMode.priceSource !== ZERO_ADDRESS) {
      const sourceRaw = await read<bigint>(marketCfg.oracle, ORACLE_ABI, "getAssetPrice", [getAddress(eMode.priceSource)]);
      priceSourceUsd = scaledToNumber(sourceRaw, unitDecimals(baseUnit));
    }

    const collateral: CollateralLeg[] = [];
    const debt: DebtLeg[] = [];
    const markets: MarketStatus[] = [];
    const collateralRows: Record<string, unknown>[] = [];
    const debtRows: Record<string, unknown>[] = [];

    active.forEach((reserve, i) => {
      const base = i * 6;
      const configRow = detail[base];
      const capsRow = detail[base + 1];
      const dataRow = detail[base + 2];
      const pausedRow = detail[base + 3];
      const supplyRow = detail[base + 4];
      const totalDebtRow = detail[base + 5];
      if (!configRow || configRow.status !== "success" || !dataRow || dataRow.status !== "success") {
        throw new Error(`Reserve data for ${reserve.symbol} (${reserve.address}) failed`);
      }
      const config = tuple(configRow.result);
      const data = tuple(dataRow.result);
      const decimals = Number(asBig(config[0]));
      const reserveLtvBps = Number(asBig(config[1]));
      const reserveLtBps = Number(asBig(config[2]));
      const isActive = asBool(config[8]);
      const isFrozen = asBool(config[9]);
      const isPaused = pausedRow?.status === "success" ? asBool(pausedRow.result) : false;
      const supplyCap = capsRow?.status === "success" ? asBig(tuple(capsRow.result)[1]) : 0n;
      const priceRaw = prices[i] ?? 0n;
      const assetPriceUsd = scaledToNumber(priceRaw, unitDecimals(baseUnit));
      const effective = effectiveReserveRisk({
        reserveIndex: reserve.index,
        ltvBps: reserveLtvBps,
        liquidationThresholdBps: reserveLtBps,
        priceUsd: assetPriceUsd,
        eMode,
        priceSourceUsd,
      });
      const priceUsd = effective.priceUsd;
      const supplied = scaledToNumber(reserve.suppliedRaw, decimals);
      const variable = scaledToNumber(reserve.variableDebtRaw, decimals);
      const stable = scaledToNumber(reserve.stableDebtRaw, decimals);
      const usdOf = (amountRaw: bigint, amount: number) =>
        effective.usedPriceSource
          ? amount * priceUsd
          : tokenValueUsd(amountRaw, decimals, priceRaw, baseUnit);
      const suppliedUsd = usdOf(reserve.suppliedRaw, supplied);
      const variableUsd = usdOf(reserve.variableDebtRaw, variable);
      const stableUsd = usdOf(reserve.stableDebtRaw, stable);
      const ltv = effective.ltvBps / 10000;
      const liquidationThreshold = effective.liquidationThresholdBps / 10000;
      const stableAsset = isStableAsset(reserve.symbol, priceUsd);
      const supplyApy = rayToAPY(asBig(data[5]), 4);
      const variableBorrowApy = rayToAPY(asBig(data[6]), 4);
      const stableBorrowApy = stable > 0 ? rayToAPY(reserve.userStableBorrowRate, 4) : rayToAPY(0, 4);
      const totalSupplyRaw = supplyRow?.status === "success" ? asBig(supplyRow.result) : asBig(data[2]);
      const totalDebtRaw = totalDebtRow?.status === "success"
        ? asBig(totalDebtRow.result)
        : asBig(data[3]) + asBig(data[4]);
      const suppliedTokens = scaledToNumber(totalSupplyRaw, decimals);
      const supplyCapTokens = Number(supplyCap);
      const capUsed = supplyCapTokens > 0 ? suppliedTokens / supplyCapTokens : null;

      if (supplied > 0) {
        collateral.push({
          id: reserve.address.toLowerCase(),
          symbol: reserve.symbol,
          amount: supplied,
          usd: suppliedUsd,
          priceUsd,
          ltv,
          liquidationThreshold,
          isStable: stableAsset,
          usageAsCollateralEnabled: reserve.usageAsCollateralEnabled,
        });
        collateralRows.push({
          symbol: reserve.symbol,
          underlying: reserve.address,
          reserveIndex: reserve.index,
          decimals,
          amount: formatTokenAmount(reserve.suppliedRaw, decimals),
          amountRaw: reserve.suppliedRaw.toString(),
          usd: jsonUsd(suppliedUsd),
          priceUsd: round(priceUsd, 8),
          ltv,
          ltvPct: bpsPct(effective.ltvBps),
          liquidationThreshold,
          liquidationThresholdPct: bpsPct(effective.liquidationThresholdBps),
          usageAsCollateralEnabled: reserve.usageAsCollateralEnabled,
          countsTowardHealthFactor: reserve.usageAsCollateralEnabled && liquidationThreshold > 0,
          addsBorrowPower: reserve.usageAsCollateralEnabled && ltv > 0,
          supplyApy,
          isStable: stableAsset,
          eModeApplied: effective.inEMode,
          usedEModePriceSource: effective.usedPriceSource,
          market: {
            isActive,
            isFrozen,
            isPaused,
            supplyCapTokens: supplyCapTokens || null,
            suppliedTokens: round(suppliedTokens, 6),
            supplyCapUsedPct: capUsed == null ? null : round(capUsed * 100, 2),
            supplyCapHeadroomTokens: supplyCapTokens > 0 ? round(supplyCapTokens - suppliedTokens, 6) : null,
            totalDebtTokens: round(scaledToNumber(totalDebtRaw, decimals), 6),
          },
        });
      }
      if (variable > 0 || stable > 0) {
        const amount = variable + stable;
        const usd = variableUsd + stableUsd;
        debt.push({
          id: reserve.address.toLowerCase(),
          symbol: reserve.symbol,
          amount,
          usd,
          priceUsd,
        });
        const variableApyNum = rayToApyNumber(asBig(data[6]));
        const stableApyNum = stable > 0 ? rayToApyNumber(reserve.userStableBorrowRate) : 0;
        const blended = amount > 0 ? (variable * variableApyNum + stable * stableApyNum) / amount : 0;
        // Four decimals matches get_live_reserve_detail; two hides a near-zero supply rate.
        debtRows.push({
          symbol: reserve.symbol,
          underlying: reserve.address,
          reserveIndex: reserve.index,
          decimals,
          amount: formatTokenAmount(reserve.variableDebtRaw + reserve.stableDebtRaw, decimals),
          amountRaw: (reserve.variableDebtRaw + reserve.stableDebtRaw).toString(),
          usd: jsonUsd(usd),
          priceUsd: round(priceUsd, 8),
          variable: {
            amount: formatTokenAmount(reserve.variableDebtRaw, decimals),
            usd: jsonUsd(variableUsd),
            borrowApy: variableBorrowApy,
          },
          stable: {
            amount: formatTokenAmount(reserve.stableDebtRaw, decimals),
            usd: jsonUsd(stableUsd),
            borrowApy: stableBorrowApy,
          },
          borrowApy: `${blended.toFixed(4)}%`,
          isStable: stableAsset,
          eModeApplied: effective.inEMode,
          market: { isActive, isFrozen, isPaused },
        });
      }
      if (supplied > 0 || variable > 0 || stable > 0) {
        markets.push({
          id: reserve.address.toLowerCase(),
          symbol: reserve.symbol,
          isActive,
          isFrozen,
          isPaused,
          supplyCapTokens,
          suppliedTokens,
          priceUsd,
        });
      }
    });

    const byUsd = (a: { usd: number }, b: { usd: number }) => b.usd - a.usd;
    collateral.sort(byUsd);
    debt.sort(byUsd);
    collateralRows.sort((a, b) => Number(b.usd) - Number(a.usd));
    debtRows.sort((a, b) => Number(b.usd) - Number(a.usd));

    const analysis = analyzeBook({ collateral, debt, shocks, targetHealthFactor });
    const account = tuple(accountRaw);
    const protocolCollateralUsd = scaledToNumber(asBig(account[0]), unitDecimals(baseUnit));
    const protocolDebtUsd = scaledToNumber(asBig(account[1]), unitDecimals(baseUnit));
    const availableBorrowsUsd = scaledToNumber(asBig(account[2]), unitDecimals(baseUnit));
    const protocolLtBps = Number(asBig(account[3]));
    const protocolLtvBps = Number(asBig(account[4]));
    const protocolHf = hfExact(asBig(account[5]));
    const headlineHf = protocolHf.value === "infinity" ? Number.POSITIVE_INFINITY : protocolHf.value;

    const subgraph = await compareSubgraphPrices(
      marketCfg.subgraphKey,
      [...collateralRows, ...debtRows].map((row) => ({
        symbol: String(row.symbol),
        underlying: String(row.underlying),
        priceUsd: Number(row.priceUsd),
      }))
    );
    const seenDeviation = new Set<string>();
    const deviations = subgraph.assets.filter((row) => {
      if (row.deviationPct == null || seenDeviation.has(row.underlying.toLowerCase())) return false;
      seenDeviation.add(row.underlying.toLowerCase());
      return true;
    }).map((row) => ({
      symbol: row.symbol,
      oracleUsd: row.oracleUsd,
      subgraphUsd: row.subgraphUsd ?? 0,
      deviationPct: row.deviationPct ?? 0,
    }));

    const flags = positionRiskFlags({
      collateral,
      debt,
      markets,
      healthFactor: headlineHf,
      healthFactorFromLegs: analysis.healthFactor,
      deviations,
    });

    const currentLtv = protocolCollateralUsd > 0 ? protocolDebtUsd / protocolCollateralUsd : null;
    const perAsset = analysis.perAssetPriceAtHealthFactor1.map((row) => ({
      symbol: row.symbol,
      underlying: getAddress(row.id),
      status: row.status,
      currentPriceUsd: round(row.currentPriceUsd, 8),
      priceUsdAtHf1: row.priceUsdAtHf1 == null ? null : round(row.priceUsdAtHf1, 8),
      dropPctAtHf1: row.dropPctAtHf1 == null ? null : round(row.dropPctAtHf1, 4),
      note: row.status === "cannot liquidate alone"
        ? "cannot liquidate alone"
        : "Price of this asset, holding every other oracle price constant, at which health factor is 1.",
    }));

    const report = {
      summary: "",
      chain,
      user,
      asOf: {
        blockNumber: blockNumber.toString(),
        timestamp: block.timestamp.toString(),
        timestampIso: new Date(Number(block.timestamp) * 1000).toISOString(),
        chainId: RPC_CHAINS[chain]?.chainId ?? null,
        source: "rpc" as const,
        rpc: rpcSource(chain, rpcUrl),
      },
      contracts: {
        pool: marketCfg.pool,
        poolDataProvider: marketCfg.poolDataProvider,
        oracle: marketCfg.oracle,
      },
      account: {
        healthFactor: protocolHf.value === "infinity" ? "infinity" : round(protocolHf.value, 6),
        healthFactorExact: protocolHf.text,
        healthFactorFromLegs: jsonHf(analysis.healthFactor),
        totalCollateralUsd: jsonUsd(protocolCollateralUsd),
        totalDebtUsd: jsonUsd(protocolDebtUsd),
        currentLtv: currentLtv == null ? null : round(currentLtv, 6),
        currentLtvPct: currentLtv == null ? null : pct(currentLtv),
        maxLtv: protocolLtvBps / 10000,
        maxLtvPct: bpsPct(protocolLtvBps),
        weightedLiquidationThreshold: protocolLtBps / 10000,
        weightedLiquidationThresholdPct: bpsPct(protocolLtBps),
        availableBorrowsUsd: jsonUsd(availableBorrowsUsd),
      },
      eMode: eMode
        ? {
            categoryId: eMode.categoryId,
            label: eModeLabel,
            ltvPct: bpsPct(eMode.ltvBps),
            liquidationThresholdPct: bpsPct(eMode.liquidationThresholdBps),
            liquidationBonusPct: bpsPct(eMode.liquidationBonusBps),
            priceSource: eMode.priceSource === ZERO_ADDRESS ? null : getAddress(eMode.priceSource),
            isolated: eMode.isolated,
            note:
              "Assets on the category collateral bitmap use the category LTV and liquidation threshold. " +
              "A non-zero price source replaces the asset oracle for assets on the collateral or borrowable bitmap. " +
              "Liquid e-modes leave priceSource unset, so AaveOracle.getAssetPrice is the price.",
          }
        : {
            categoryId: 0,
            label: null,
            ltvPct: null,
            liquidationThresholdPct: null,
            priceSource: null,
            note: "Category 0 is not e-mode. Each reserve uses its own LTV, liquidation threshold, and oracle price.",
          },
      collateral: collateralRows,
      debt: debtRows,
      scenarios: {
        note:
          "Shocks drop every non-stable collateral price together. Stable collateral and every debt price stay constant. " +
          "Health factor is sum(collateral USD × liquidation threshold) / debt USD.",
        shocks: analysis.shocks.map((shock) => ({
          dropPct: shock.dropPct,
          healthFactor: jsonHf(shock.healthFactor),
          collateralUsd: jsonUsd(shock.collateralUsd),
        })),
        jointDropToHealthFactor1: {
          dropPct: analysis.jointDropToHealthFactor1.dropPct == null
            ? null
            : round(analysis.jointDropToHealthFactor1.dropPct, 4),
          reason: analysis.jointDropToHealthFactor1.reason,
        },
        perAssetPriceAtHealthFactor1: perAsset,
      },
      target: {
        healthFactor: targetHealthFactor,
        alreadyAbove: analysis.alreadyAboveTarget,
        repayUsd: jsonUsd(analysis.repayUsd),
        collateralAddUsd: analysis.collateralAddUsd == null ? null : jsonUsd(analysis.collateralAddUsd),
        repay: analysis.repay.map((row) => ({
          symbol: row.symbol,
          underlying: getAddress(row.id),
          amount: jsonToken(row.amount),
          usd: jsonUsd(row.usd),
          exceedsBalance: row.exceedsBalance,
        })),
        collateralAdd: analysis.collateralAdd.map((row) => ({
          symbol: row.symbol,
          underlying: getAddress(row.id),
          amount: row.amount == null ? null : jsonToken(row.amount),
          usd: row.usd == null ? null : jsonUsd(row.usd),
          note: row.note,
        })),
        headroom: {
          extraBorrowUsd: jsonUsd(analysis.extraBorrowUsd),
          note:
            "extraBorrowUsd is additional debt, in base-currency USD, before health factor falls to the target. " +
            "account.availableBorrowsUsd is the protocol max-LTV headroom, which is a different limit. " +
            "withdrawableCollateral is how much of each collateral asset can be removed before health factor falls to the target, holding the others constant.",
          withdrawableCollateral: analysis.withdrawable.map((row) => ({
            symbol: row.symbol,
            underlying: getAddress(row.id),
            amount: jsonToken(row.amount),
            usd: jsonUsd(row.usd),
            blocked: row.blocked,
            note: row.note,
          })),
        },
      },
      riskFlags: flags,
      subgraphPriceCheck: subgraph,
      notes: [
        "Headline health factor, totals, max LTV, and weighted liquidation threshold are Pool.getUserAccountData at asOf.blockNumber.",
        "Per-asset USD uses AaveOracle prices at that same block. Scenario health factors use those per-asset values.",
        "Supply and variable borrow APY are compounded from the reserve liquidity and variable borrow rates. Stable borrow APY uses the user's stable rate when they still have stable debt.",
      ],
    };

    const hfText = typeof report.account.healthFactor === "number"
      ? report.account.healthFactor.toFixed(4)
      : report.account.healthFactor;
    const alone = perAsset.filter((row) => row.status === "cannot liquidate alone").map((row) => row.symbol);
    report.summary = positionSummary({
      chain,
      blockNumber: report.asOf.blockNumber,
      healthFactorText: hfText,
      collateral: report.collateral as { amount: string; symbol: string; usd: number }[],
      debt: report.debt as { amount: string; symbol: string; usd: number }[],
      jointDropPct: report.scenarios.jointDropToHealthFactor1.dropPct,
      jointDropReason: report.scenarios.jointDropToHealthFactor1.reason,
      cannotLiquidateAlone: alone,
    });
    return report;
  });
}
