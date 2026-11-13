import { humanAmount } from "./format.js";
import { rayToAPR, rayToAPY } from "./rates.js";

const MONTH_ABBR: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parsePTMaturity(symbol: string): Date | null {
  const m = symbol.match(/(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const month = MONTH_ABBR[m[2]];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[1]));
}

function toBig(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Cash in the reserve is aToken supply minus variable and stable debt.
 * The subgraph's own `availableLiquidity` lags that identity (it understated
 * Ethereum V3 USDC by ~$24M in the 2026-11-05 compare).
 */
export function derivedAvailableRaw(reserve: Record<string, unknown>): bigint | null {
  const a = toBig(reserve["totalATokenSupply"]);
  const variable = toBig(reserve["totalCurrentVariableDebt"]);
  if (a == null || variable == null) return null;
  const stable = toBig(reserve["totalPrincipalStableDebt"]) ?? 0n;
  const debt = variable + stable;
  return a > debt ? a - debt : 0n;
}

export function availableRawUnits(
  reserve: Record<string, unknown>
): { units: string; source: string } | null {
  const derived = derivedAvailableRaw(reserve);
  if (derived != null) {
    return {
      units: derived.toString(),
      source: "totalATokenSupply - (variable + stable debt)",
    };
  }
  const raw = reserve["availableLiquidity"];
  if (typeof raw === "string") {
    return { units: raw, source: "subgraph availableLiquidity (fallback)" };
  }
  return null;
}

export interface SubgraphFreshness {
  block: unknown;
  timestamp: unknown;
  lagSeconds: number | null;
  source: "thegraph-subgraph";
}

/** Wall-clock lag of a subgraph payload versus `_meta.block.timestamp`. */
export function attachSubgraphMeta<T>(data: T, fetchedAtMs = Date.now()): T {
  if (!data || typeof data !== "object") return data;
  const meta = (data as { _meta?: { block?: { number?: unknown; timestamp?: unknown } } })._meta?.block;
  if (!meta) return data;
  const blockTsSec = Number(meta.timestamp);
  const lagSeconds = Number.isFinite(blockTsSec)
    ? Math.max(0, Math.round(fetchedAtMs / 1000 - blockTsSec))
    : null;
  const freshness: SubgraphFreshness = {
    block: meta.number,
    timestamp: meta.timestamp,
    lagSeconds,
    source: "thegraph-subgraph",
  };
  return { ...(data as object), _freshness: freshness } as T;
}

/**
 * Annotate reserve rows in place: data-quality warnings plus a
 * `_humanReadable` block. `availableLiquidity` there is derived
 * (aToken − debt). `supplyAPY` / `variableBorrowAPY` are compounded.
 */
export function annotateReserves(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;

  const key = Array.isArray(d["reserves"])
    ? "reserves"
    : Array.isArray(d["markets"])
    ? "markets"
    : null;
  if (!key) return data;

  const reserves = d[key] as Array<Record<string, unknown>>;
  const now = new Date();
  const flagged: string[] = [];

  for (const reserve of reserves) {
    const warnings: string[] = [];
    const symbol = (reserve["symbol"] ?? reserve["name"] ?? "") as string;
    const decimals = Number(reserve["decimals"] ?? 18);
    const rawLiq = reserve["totalLiquidity"] as string | undefined;
    const rawUtil = reserve["utilizationRate"] as string | undefined;

    if (rawLiq !== undefined) {
      const liq = Number(rawLiq);
      if (!isNaN(liq) && liq < 0) {
        const humanLiq = (liq / Math.pow(10, decimals)).toFixed(2);
        warnings.push(
          `NEGATIVE_LIQUIDITY (${humanLiq}): debt exceeds deposits — ` +
          `accounting artifact from token migration or interest accrual timing. ` +
          `Do not treat this as real TVL.`
        );
      }
    }

    if (rawUtil !== undefined) {
      const util = Number(rawUtil);
      if (!isNaN(util)) {
        if (util > 1.0) {
          warnings.push(
            `OVER_UTILIZED (${(util * 100).toFixed(1)}%): utilization >100% is impossible in a healthy pool — ` +
            `accounting artifact, typically from token migrations where debt persists after supply is removed.`
          );
        } else if (util < -0.05) {
          warnings.push(
            `NEGATIVE_UTILIZATION (${(util * 100).toFixed(2)}%): interest accrual or accounting artifact — ` +
            `ignore for rate calculations. Actual utilization is effectively 0%.`
          );
        }
      }
    }

    if (symbol.startsWith("PT-")) {
      const maturity = parsePTMaturity(symbol);
      if (maturity && maturity < now) {
        const dateStr = maturity.toLocaleDateString("en-US", {
          year: "numeric", month: "short", day: "numeric",
        });
        warnings.push(
          `EXPIRED_PENDLE_PT (matured ${dateStr}): this principal token has passed maturity. ` +
          `It now trades at par and its risk profile has fundamentally changed. ` +
          `The near-zero liquidation threshold (${reserve["reserveLiquidationThreshold"] ?? "?"}bps) ` +
          `means positions cannot be effectively liquidated.`
        );
      }
    }

    if (warnings.length > 0) {
      reserve["_dataQualityWarnings"] = warnings;
      flagged.push(symbol);
    }

    if (reserve["totalLiquidity"] !== undefined) {
      const h: Record<string, unknown> = {};
      const lr = reserve["liquidityRate"] as string | undefined;
      const vbr = reserve["variableBorrowRate"] as string | undefined;
      const sbr = reserve["stableBorrowRate"] as string | undefined;
      const utilRaw = reserve["utilizationRate"] as string | undefined;
      const liqRaw = reserve["totalLiquidity"] as string | undefined;
      const rawAvail = reserve["availableLiquidity"] as string | undefined;
      const baseLTV = reserve["baseLTVasCollateral"] as string | undefined;
      const liqThresh = reserve["reserveLiquidationThreshold"] as string | undefined;
      const liqBonus = reserve["reserveLiquidationBonus"] as string | undefined;

      if (lr) {
        h["supplyAPY"] = rayToAPY(lr);
        h["supplyAPR"] = rayToAPR(lr);
      }
      if (vbr) {
        h["variableBorrowAPY"] = rayToAPY(vbr);
        h["variableBorrowAPR"] = rayToAPR(vbr);
      }
      if (sbr && Number(sbr) > 0) {
        h["stableBorrowAPY"] = rayToAPY(sbr);
        h["stableBorrowAPR"] = rayToAPR(sbr);
      }

      if (utilRaw !== undefined) {
        const u = Number(utilRaw);
        h["utilization"] = (!isNaN(u) && u >= 0 && u <= 1)
          ? (u * 100).toFixed(1) + "%" : "anomalous (see _dataQualityWarnings)";
      }
      if (liqRaw !== undefined) h["totalLiquidity"] = humanAmount(liqRaw, decimals, symbol);

      const avail = availableRawUnits(reserve);
      if (avail) {
        h["availableLiquidity"] = humanAmount(avail.units, decimals, symbol);
        h["availableLiquiditySource"] = avail.source;
        if (avail.source.startsWith("totalATokenSupply") && rawAvail !== undefined) {
          h["availableLiquiditySubgraphRaw"] = humanAmount(rawAvail, decimals, symbol);
        }
        reserve["availableLiquidityDerived"] = avail.units;
      }

      if (baseLTV !== undefined) h["maxLTV"] = (Number(baseLTV) / 100).toFixed(2) + "%";
      if (liqThresh !== undefined) h["liquidationThreshold"] = (Number(liqThresh) / 100).toFixed(2) + "%";
      if (liqBonus !== undefined) {
        const penalty = (Number(liqBonus) / 100 - 100).toFixed(2);
        if (Number(penalty) > 0) h["liquidationPenalty"] = penalty + "%";
      }
      reserve["_humanReadable"] = h;
    }
  }

  if (flagged.length > 0) {
    d["_anomalousReserves"] = flagged;
    d["_dataQualityNote"] =
      `${flagged.length} reserve(s) have data quality warnings (see _dataQualityWarnings on each). ` +
      `Raw subgraph values are preserved. These are on-chain accounting artifacts, not MCP errors. ` +
      `Flagged: ${flagged.join(", ")}`;
  }

  return d;
}
