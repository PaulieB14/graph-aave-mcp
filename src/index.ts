#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryChain } from "./graphClient.js";
import { CHAINS, CHAIN_NAMES, LENDING_CHAIN_NAMES } from "./subgraphs.js";
import {
  LIQUIDATION_RISK_CHAINS,
  RISK_CHAIN_NAMES,
  getAtRiskPositions,
  getUserRiskPositions,
  getProtocolRiskStats,
  getRiskAlerts,
  getRiskLiquidations,
  getHealthFactorHistory,
  getCrossChainRiskSummary,
} from "./liquidationRisk.js";
import {
  getV4Hubs,
  getV4Spokes,
  getV4Reserves,
  getV4Chains,
  getV4ExchangeRate,
  getV4Asset,
  getV4AssetPriceHistory,
  getV4ProtocolHistory,
  getV4UserPositions,
  getV4UserSummary,
  getV4UserSupplies,
  getV4UserBorrows,
  getV4UserBalances,
  getV4UserActivities,
  getV4ClaimableRewards,
  getV4SwapQuote,
} from "./aaveV4Api.js";

const server = new McpServer({
  name: "graph-aave-mcp",
  version: "4.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a raw token amount (BigInt string + decimals) into human-readable form */
function humanAmount(raw: string, decimals: number, symbol = ""): string {
  const n = Number(raw) / Math.pow(10, decimals);
  let formatted: string;
  if (Math.abs(n) >= 1e9) formatted = (n / 1e9).toFixed(2) + "B";
  else if (Math.abs(n) >= 1e6) formatted = (n / 1e6).toFixed(2) + "M";
  else if (Math.abs(n) >= 1e3) formatted = (n / 1e3).toFixed(2) + "K";
  else if (Math.abs(n) >= 1) formatted = n.toFixed(4);
  else formatted = n.toFixed(8);
  return symbol ? formatted + " " + symbol : formatted;
}

/** Convert a RAY-unit rate (1e27) to APY percentage string */
function rayToAPY(raw: string): string {
  return (Number(raw) / 1e27 * 100).toFixed(2) + "%";
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Data quality annotations for reserve responses
// ---------------------------------------------------------------------------
// Many AAVE subgraph reserves contain accounting artifacts that can
// confuse AI agents: negative TVL from token migrations, >100% utilization,
// expired Pendle PT tokens, and interest-accrual timing glitches.
// This annotates reserves in-place and adds a top-level summary.

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

function annotateReserves(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;

  // Works for both { reserves: [...] } and { markets: [...] } shapes
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
          // Only flag significant negative util (>5%), minor ones are timing noise
          warnings.push(
            `NEGATIVE_UTILIZATION (${(util * 100).toFixed(2)}%): interest accrual or accounting artifact — ` +
            `ignore for rate calculations. Actual utilization is effectively 0%.`
          );
        }
      }
    }

    // Pendle PT token maturity check
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

    // Always add _humanReadable for AAVE-native reserves (not Messari markets)
    if (reserve["totalLiquidity"] !== undefined) {
      const h: Record<string, unknown> = {};
      const lr = reserve["liquidityRate"] as string | undefined;
      const vbr = reserve["variableBorrowRate"] as string | undefined;
      const sbr = reserve["stableBorrowRate"] as string | undefined;
      const rawUtil = reserve["utilizationRate"] as string | undefined;
      const rawLiq = reserve["totalLiquidity"] as string | undefined;
      const rawAvail = reserve["availableLiquidity"] as string | undefined;
      const baseLTV = reserve["baseLTVasCollateral"] as string | undefined;
      const liqThresh = reserve["reserveLiquidationThreshold"] as string | undefined;
      const liqBonus = reserve["reserveLiquidationBonus"] as string | undefined;

      if (lr) h["supplyAPY"] = rayToAPY(lr);
      if (vbr) h["variableBorrowAPY"] = rayToAPY(vbr);
      if (sbr && Number(sbr) > 0) h["stableBorrowAPY"] = rayToAPY(sbr);

      if (rawUtil !== undefined) {
        const u = Number(rawUtil);
        h["utilization"] = (!isNaN(u) && u >= 0 && u <= 1)
          ? (u * 100).toFixed(1) + "%" : "anomalous (see _dataQualityWarnings)";
      }
      if (rawLiq !== undefined) h["totalLiquidity"] = humanAmount(rawLiq, decimals, symbol);
      if (rawAvail !== undefined) h["availableLiquidity"] = humanAmount(rawAvail, decimals, symbol);
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

// ---------------------------------------------------------------------------
// Position dashboard — synthesizes raw userReserves into human-readable summary
// ---------------------------------------------------------------------------
interface UserReserveRaw {
  reserve: {
    symbol: string;
    decimals: number;
    liquidityRate: string;
    variableBorrowRate: string;
    baseLTVasCollateral: string;
    reserveLiquidationThreshold: string;
    price: { priceInEth: string };
    utilizationRate: string;
    availableLiquidity: string;
  };
  currentATokenBalance: string;
  currentVariableDebt: string;
  currentStableDebt: string;
  currentTotalDebt: string;
  usageAsCollateralEnabledOnUser: boolean;
}

function computePositionDashboard(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  const userReserves = d["userReserves"] as UserReserveRaw[] | undefined;
  if (!userReserves || userReserves.length === 0) return data;

  let collateralUSD = 0;
  let debtUSD = 0;
  const positions: Record<string, unknown>[] = [];
  const warnings: string[] = [];

  for (const ur of userReserves) {
    const r = ur.reserve;
    const dec = r.decimals;
    // V3 subgraphs store priceInEth as USD × 1e8; V2 as ETH × 1e18.
    // Since userReserves queries only run on V3 chains (V2 unsupported),
    // we safely use USD × 1e8 interpretation.
    const priceUSD = Number(r.price.priceInEth) / 1e8;
    const liqThreshold = Number(r.reserveLiquidationThreshold) / 10000;
    const supplyBal = Number(ur.currentATokenBalance) / Math.pow(10, dec);
    const debtBal = Number(ur.currentTotalDebt) / Math.pow(10, dec);
    const hasSupply = supplyBal > 1e-12;
    const hasDebt = debtBal > 1e-12;
    if (!hasSupply && !hasDebt) continue;

    const supplyAPY = Number(r.liquidityRate) / 1e27 * 100;
    const borrowAPY = Number(r.variableBorrowRate) / 1e27 * 100;

    if (ur.usageAsCollateralEnabledOnUser && hasSupply) {
      collateralUSD += supplyBal * priceUSD * liqThreshold;
    }
    if (hasDebt) {
      debtUSD += debtBal * priceUSD;
    }

    // Withdrawal liquidity check
    const util = Number(r.utilizationRate);
    if (hasSupply && util > 0.95) {
      const avail = Number(r.availableLiquidity) / Math.pow(10, dec);
      const withdrawable = Math.min(supplyBal, avail);
      warnings.push(
        `⚠️ ${r.symbol} pool is ${(util * 100).toFixed(0)}% utilized — ` +
        `only ~${humanAmount(String(Math.round(withdrawable * Math.pow(10, dec))), dec, r.symbol)} ` +
        `available to withdraw (your balance: ${humanAmount(ur.currentATokenBalance, dec, r.symbol)})`
      );
    }

    const pos: Record<string, unknown> = { asset: r.symbol };
    if (hasSupply) {
      pos["supplied"] = humanAmount(ur.currentATokenBalance, dec, r.symbol);
      pos["supplyAPY"] = supplyAPY.toFixed(2) + "%";
      pos["collateralEnabled"] = ur.usageAsCollateralEnabledOnUser;
      pos["earningPerYear_approx"] = humanAmount(
        String(Math.round(supplyBal * supplyAPY / 100 * Math.pow(10, dec))), dec, r.symbol
      );
    }
    if (hasDebt) {
      pos["borrowed"] = humanAmount(ur.currentTotalDebt, dec, r.symbol);
      pos["variableBorrowAPY"] = borrowAPY.toFixed(2) + "%";
      pos["costPerYear_approx"] = humanAmount(
        String(Math.round(debtBal * borrowAPY / 100 * Math.pow(10, dec))), dec, r.symbol
      );
    }
    positions.push(pos);
  }

  const hf = debtUSD > 0 ? collateralUSD / debtUSD : null;

  if (hf !== null) {
    if (hf < 1.0) {
      warnings.push("🚨 LIQUIDATABLE: health factor below 1.0 — repay debt or add collateral immediately.");
    } else if (hf < 1.2) {
      warnings.push(`⚠️ HIGH RISK: health factor ${hf.toFixed(2)} is dangerously close to liquidation (1.0). Add collateral or repay debt.`);
    } else if (hf < 1.5) {
      warnings.push(`⚠️ MODERATE RISK: health factor ${hf.toFixed(2)}. Recommend keeping above 1.5 as a safety buffer.`);
    }
  }

  const fmtUSD = (v: number) => v >= 1e6 ? "$" + (v/1e6).toFixed(2) + "M"
    : v >= 1e3 ? "$" + (v/1e3).toFixed(2) + "K" : "$" + v.toFixed(2);

  d["_dashboard"] = {
    healthFactor: hf !== null ? hf.toFixed(4) : "∞ (no debt)",
    healthStatus: hf === null ? "No debt — no liquidation risk" :
      hf >= 2.0 ? "Safe" : hf >= 1.5 ? "Moderate" : hf >= 1.0 ? "High Risk" : "LIQUIDATABLE",
    collateralWeightedUSD: fmtUSD(collateralUSD),
    debtUSD: fmtUSD(debtUSD),
    activePositions: positions,
    warnings: warnings.length > 0 ? warnings : ["No warnings — position looks healthy."],
    note: "USD values from on-chain price oracle (USD × 1e8). Health factor uses on-chain liquidation thresholds.",
  };

  return d;
}

// ---------------------------------------------------------------------------
// Tool 1 — list_aave_chains
// ---------------------------------------------------------------------------
server.registerTool(
  "list_aave_chains",
  {
    description:
      "Use this when the user asks which AAVE chains are supported, wants to pick a network, " +
      "or needs to discover available AAVE deployments. " +
      "Returns all supported chains with their subgraph IDs, protocol version (V2/V3), " +
      "chain name, 30-day query volume, and key entities. " +
      "Chains: Ethereum, Base, Arbitrum, Polygon, Optimism, Avalanche, Fantom (V3 + V2 legacy), " +
      "plus AAVE Governance V3. Always call this first if chain is ambiguous.",
  },
  async () => {
    const list = Object.entries(CHAINS)
      .map(([key, cfg]) => ({
        id: key,
        name: cfg.name,
        chain: cfg.chain,
        version: cfg.version,
        subgraphId: cfg.subgraphId,
        queries30d: cfg.queries30d,
        isGovernance: cfg.isGovernance ?? false,
        description: cfg.description,
        keyEntities: cfg.keyEntities,
      }))
      .sort((a, b) => b.queries30d - a.queries30d);
    return textResult(list);
  }
);

// ---------------------------------------------------------------------------
// Tool 2 — get_aave_reserves
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_reserves",
  {
    description:
      "Use this when the user asks about AAVE lending markets, available assets, " +
      "supply APY, borrow APY, TVL, utilization rate, collateral factors, or " +
      "liquidation thresholds on a specific chain. " +
      "Returns all active reserves sorted by total liquidity (TVL). " +
      "RATE CONVERSION: liquidityRate and variableBorrowRate are in RAY units (1e27). " +
      "Supply APY % = liquidityRate / 1e27 * 100. Borrow APY % = variableBorrowRate / 1e27 * 100. " +
      "Amounts are in native token units — divide by 10^decimals for human-readable. " +
      "Ideal for: 'What assets can I lend on Arbitrum?', 'What is USDC supply rate on Base?', " +
      "'Show me all AAVE V3 markets on Polygon'.",
    inputSchema: {
      chain: z
        .enum(LENDING_CHAIN_NAMES)
        .describe(
          "Chain identifier (e.g. ethereum, base, arbitrum, polygon, optimism, avalanche). " +
            "Use list_aave_chains to see all options."
        ),
      includeInactive: z
        .boolean()
        .default(false)
        .describe(
          "Set true to include frozen, paused, or inactive reserves. Default false (active only)."
        ),
    },
  },
  async ({ chain, includeInactive }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari standardized schema (markets, not reserves)
      if (cfg.isMessari) {
        const activeFilter = includeInactive ? "" : ", where: { isActive: true }";
        const query = `{
          markets(first: 100, orderBy: totalValueLockedUSD, orderDirection: desc${activeFilter}) {
            id
            name
            isActive
            canBorrowFrom
            canUseAsCollateral
            maximumLTV
            liquidationThreshold
            liquidationPenalty
            totalValueLockedUSD
            totalBorrowBalanceUSD
            totalDepositBalanceUSD
            inputToken { id symbol name decimals }
            rates { side type rate }
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(annotateReserves(data));
      }

      const isPausedField = cfg.hasIsPaused !== false ? "\n          isPaused" : "";
      const where = includeInactive ? "" : ", where: { isActive: true }";
      const query = `{
        reserves(first: 100, orderBy: totalLiquidity, orderDirection: desc${where}) {
          id
          symbol
          name
          decimals
          underlyingAsset
          isActive
          isFrozen${isPausedField}
          borrowingEnabled
          usageAsCollateralEnabled
          availableLiquidity
          totalLiquidity
          totalATokenSupply
          totalCurrentVariableDebt
          totalPrincipalStableDebt
          utilizationRate
          liquidityRate
          variableBorrowRate
          stableBorrowRate
          baseLTVasCollateral
          reserveLiquidationThreshold
          reserveLiquidationBonus
          reserveFactor
          price { priceInEth }
          aToken { id }
          vToken { id }
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(annotateReserves(data));
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3 — get_aave_reserve
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_reserve",
  {
    description:
      "Use this when the user asks about a specific AAVE asset in detail — " +
      "e.g. 'Tell me everything about USDC on Ethereum AAVE', 'What are the WETH borrow parameters?', " +
      "'What is the liquidation threshold for WBTC collateral?'. " +
      "Returns full reserve config: current rates, TVL, LTV, liquidation parameters, " +
      "lifetime stats (total borrows/repayments/liquidations), and token addresses. " +
      "RATE CONVERSION: divide liquidityRate / variableBorrowRate by 1e27 * 100 for APY %.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      symbol: z
        .string()
        .describe(
          "Token symbol — case-insensitive (e.g. USDC, WETH, WBTC, DAI, USDT, LINK, AAVE)"
        ),
    },
  },
  async ({ chain, symbol }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari standardized schema (markets, not reserves)
      if (cfg.isMessari) {
        const query = `{
          markets(where: { name_contains: "${symbol.toUpperCase()}" }, first: 5) {
            id
            name
            isActive
            canBorrowFrom
            canUseAsCollateral
            maximumLTV
            liquidationThreshold
            liquidationPenalty
            totalValueLockedUSD
            totalBorrowBalanceUSD
            totalDepositBalanceUSD
            inputToken { id symbol name decimals }
            rates { side type rate }
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(annotateReserves(data));
      }

      const v3Only = cfg.hasIsPaused !== false;
      const isPausedField = v3Only ? "\n          isPaused" : "";
      const lifetimeFields = v3Only ? "\n          lifetimeSuppliersInterestEarned\n          lifetimeFlashLoanPremium" : "";
      const query = `{
        reserves(where: { symbol: "${symbol.toUpperCase()}" }) {
          id
          symbol
          name
          decimals
          underlyingAsset
          isActive
          isFrozen${isPausedField}
          borrowingEnabled
          usageAsCollateralEnabled
          availableLiquidity
          totalLiquidity
          totalATokenSupply
          totalCurrentVariableDebt
          totalPrincipalStableDebt
          utilizationRate
          liquidityRate
          variableBorrowRate
          stableBorrowRate
          averageStableRate
          baseLTVasCollateral
          reserveLiquidationThreshold
          reserveLiquidationBonus
          reserveFactor
          price { priceInEth }
          aToken { id }
          vToken { id }
          sToken { id }${lifetimeFields}
          lifetimeBorrows
          lifetimeRepayments
          lifetimeWithdrawals
          lifetimeLiquidated
          lifetimeFlashLoans
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(annotateReserves(data));
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 4 — get_aave_user_position
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_user_position",
  {
    description:
      "Use this when the user asks about a wallet's AAVE position — " +
      "'What is my health factor?', 'What have I supplied to AAVE?', 'How much have I borrowed?', " +
      "'Am I at risk of liquidation?', 'Show me my collateral and debt on Arbitrum'. " +
      "Returns all supplied assets (with aToken balances), all borrowed assets " +
      "(variable + stable debt), collateral flags, and e-mode category. " +
      "Health Factor ≈ sum(collateral_i * price_i * liqThreshold_i) / sum(debt_i * price_i). " +
      "HF < 1.0 = liquidatable. Amounts in native token units — divide by 10^decimals.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      userAddress: z
        .string()
        .describe(
          "Ethereum wallet address of the user (0x..., lowercase). " +
            "Returns empty arrays if address has no AAVE positions."
        ),
    },
  },
  async ({ chain, userAddress }) => {
    try {
      const cfg = CHAINS[chain];
      if (cfg.isMessari) {
        return textResult({ error: "Fantom uses a Messari subgraph schema that does not index userReserves. Use query_aave_subgraph with the 'positions' entity to query user positions on Fantom." });
      }
      const addr = userAddress.toLowerCase();
      const eModeField = cfg.hasIsPaused !== false
        ? "\n          eModeCategoryId { id label ltv liquidationThreshold }" : "";
      const query = `{
        userReserves(where: { user: "${addr}" }, first: 100) {
          reserve {
            symbol
            name
            decimals
            underlyingAsset
            liquidityRate
            variableBorrowRate
            stableBorrowRate
            baseLTVasCollateral
            reserveLiquidationThreshold
            reserveLiquidationBonus
            utilizationRate
            availableLiquidity
            price { priceInEth }
          }
          scaledATokenBalance
          currentATokenBalance
          usageAsCollateralEnabledOnUser
          scaledVariableDebt
          currentVariableDebt
          principalStableDebt
          currentStableDebt
          currentTotalDebt
          liquidityRate
          stableBorrowLastUpdateTimestamp
        }
        user(id: "${addr}") {
          id
          borrowedReservesCount
          unclaimedRewards${eModeField}
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(computePositionDashboard(data));
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 5 — simulate_health_factor
// ---------------------------------------------------------------------------
server.registerTool(
  "simulate_health_factor",
  {
    description:
      "Use this when the user wants to simulate how a price change affects their AAVE health factor — " +
      "'What happens to my health factor if ETH drops 20%?', " +
      "'How much can WBTC fall before I get liquidated?', " +
      "'Simulate a 30% drop in my collateral asset'. " +
      "Fetches the user's full position, computes current health factor, " +
      "then recalculates it after applying the specified price change to the target asset. " +
      "Health Factor < 1.0 means the position is liquidatable.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      userAddress: z.string().describe("Wallet address of the user (0x...)"),
      assetSymbol: z
        .string()
        .describe(
          "Symbol of the asset whose price changes (e.g. WETH, WBTC, USDC)"
        ),
      priceChangePct: z
        .number()
        .describe(
          "Price change percentage — negative for drops, positive for gains. " +
            "E.g. -20 means the asset price falls 20%."
        ),
    },
  },
  async ({ chain, userAddress, assetSymbol, priceChangePct }) => {
    try {
      const cfg = CHAINS[chain];
      if (cfg.isMessari) {
        return textResult({ error: "Fantom uses a Messari subgraph schema that does not index userReserves. Health factor simulation is not available for Fantom." });
      }
      const addr = userAddress.toLowerCase();
      const query = `{
        userReserves(where: { user: "${addr}" }, first: 100) {
          reserve {
            symbol
            decimals
            baseLTVasCollateral
            reserveLiquidationThreshold
            price { priceInEth }
          }
          currentATokenBalance
          usageAsCollateralEnabledOnUser
          currentVariableDebt
          currentStableDebt
        }
      }`;
      const data = (await queryChain(cfg.subgraphId, query)) as {
        userReserves: Array<{
          reserve: {
            symbol: string;
            decimals: number;
            baseLTVasCollateral: string;
            reserveLiquidationThreshold: string;
            price: { priceInEth: string };
          };
          currentATokenBalance: string;
          usageAsCollateralEnabledOnUser: boolean;
          currentVariableDebt: string;
          currentStableDebt: string;
        }>;
      };

      if (!data.userReserves || data.userReserves.length === 0) {
        return textResult({ error: "No AAVE positions found for this address on this chain." });
      }

      const target = assetSymbol.toUpperCase();
      const multiplier = 1 + priceChangePct / 100;

      let collateralETH = 0;
      let collateralETHAfter = 0;
      let debtETH = 0;
      let debtETHAfter = 0;

      for (const ur of data.userReserves) {
        const { reserve } = ur;
        const decimals = reserve.decimals;
        const priceEth = Number(reserve.price.priceInEth) / 1e18;
        const liqThreshold = Number(reserve.reserveLiquidationThreshold) / 10000;
        const isTarget = reserve.symbol.toUpperCase() === target;

        // Supplied (collateral)
        const aBalance = Number(ur.currentATokenBalance) / Math.pow(10, decimals);
        if (ur.usageAsCollateralEnabledOnUser && aBalance > 0) {
          const col = aBalance * priceEth * liqThreshold;
          collateralETH += col;
          collateralETHAfter += isTarget ? col * multiplier : col;
        }

        // Borrowed (debt)
        const debt =
          (Number(ur.currentVariableDebt) + Number(ur.currentStableDebt)) /
          Math.pow(10, decimals);
        if (debt > 0) {
          const d = debt * priceEth;
          debtETH += d;
          debtETHAfter += isTarget ? d * multiplier : d;
        }
      }

      const currentHF = debtETH > 0 ? collateralETH / debtETH : Infinity;
      const simulatedHF = debtETHAfter > 0 ? collateralETHAfter / debtETHAfter : Infinity;
      const liquidationPoint =
        collateralETH > 0 && debtETH > 0
          ? ((collateralETH / debtETH - 1) * 100).toFixed(2)
          : null;

      return textResult({
        chain,
        userAddress: addr,
        assetSimulated: target,
        priceChangePct,
        currentHealthFactor: currentHF === Infinity ? "∞ (no debt)" : currentHF.toFixed(4),
        simulatedHealthFactor:
          simulatedHF === Infinity ? "∞ (no debt)" : simulatedHF.toFixed(4),
        liquidationRisk:
          simulatedHF < 1.0
            ? "LIQUIDATABLE after this price change"
            : simulatedHF < 1.2
            ? "HIGH RISK — close to liquidation threshold"
            : "Safe",
        note:
          liquidationPoint !== null
            ? `Current collateral buffer: ${liquidationPoint}% above liquidation threshold`
            : null,
        rateConversionNote:
          "Health Factor < 1.0 means position is liquidatable. " +
          "Computed using on-chain liquidation thresholds from the subgraph.",
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 6 — get_recent_borrows
// ---------------------------------------------------------------------------
server.registerTool(
  "get_recent_borrows",
  {
    description:
      "Use this when the user asks about recent borrowing activity on AAVE — " +
      "'Who has been borrowing USDC on Ethereum?', 'Show me recent WETH borrows on Arbitrum', " +
      "'What has address 0x... borrowed recently?', 'Show borrow volume by asset'. " +
      "Returns borrow events with: borrower address, asset, raw amount, borrow rate, " +
      "rate mode (variable=2/stable=1), and timestamp. " +
      "Divide amount by 10^decimals for human-readable value.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of borrow events to return (1–100, default 20)"),
      userAddress: z
        .string()
        .optional()
        .describe("Optional: filter by borrower Ethereum address (0x...)"),
      reserveSymbol: z
        .string()
        .optional()
        .describe("Optional: filter by asset symbol (e.g. USDC, WETH, DAI)"),
    },
  },
  async ({ chain, first, userAddress, reserveSymbol }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari schema (account/asset instead of user/reserve)
      if (cfg.isMessari) {
        const messariFilters: string[] = [];
        if (userAddress) messariFilters.push(`account: "${userAddress.toLowerCase()}"`);
        if (reserveSymbol) messariFilters.push(`asset_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
        const messariWhere = messariFilters.length > 0 ? `, where: { ${messariFilters.join(", ")} }` : "";
        const query = `{
          borrows(first: ${first}, orderBy: timestamp, orderDirection: desc${messariWhere}) {
            id
            timestamp
            account { id }
            asset { symbol name decimals }
            amount
            amountUSD
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      const filters: string[] = [];
      if (userAddress) filters.push(`user: "${userAddress.toLowerCase()}"`);
      if (reserveSymbol)
        filters.push(`reserve_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
      const where =
        filters.length > 0 ? `, where: { ${filters.join(", ")} }` : "";

      const query = `{
        borrows(first: ${first}, orderBy: timestamp, orderDirection: desc${where}) {
          id
          txHash
          timestamp
          user { id }
          reserve { symbol name decimals }
          amount
          borrowRate
          borrowRateMode
          referrer
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 7 — get_recent_supplies
// ---------------------------------------------------------------------------
server.registerTool(
  "get_recent_supplies",
  {
    description:
      "Use this when the user asks about recent deposit/supply activity on AAVE — " +
      "'Who has been supplying ETH on Base?', 'Show me recent USDC deposits on Polygon', " +
      "'What has address 0x... deposited recently?'. " +
      "V3 chains use the 'supply' entity; V2 chains use 'deposit' — handled automatically. " +
      "Returns: supplier address, asset symbol, raw amount, and timestamp. " +
      "Divide amount by 10^decimals for human-readable value.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of supply events to return (1–100, default 20)"),
      userAddress: z
        .string()
        .optional()
        .describe("Optional: filter by supplier address (0x...)"),
      reserveSymbol: z
        .string()
        .optional()
        .describe("Optional: filter by asset symbol (e.g. USDC, WETH, WBTC)"),
    },
  },
  async ({ chain, first, userAddress, reserveSymbol }) => {
    try {
      const cfg = CHAINS[chain];
      const filters: string[] = [];
      if (userAddress) filters.push(`user: "${userAddress.toLowerCase()}"`);
      if (reserveSymbol)
        filters.push(`reserve_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
      const where =
        filters.length > 0 ? `, where: { ${filters.join(", ")} }` : "";

      // Fantom uses Messari schema (deposits entity with different fields)
      if (cfg.isMessari) {
        const messariFilters: string[] = [];
        if (userAddress) messariFilters.push(`account: "${userAddress.toLowerCase()}"`);
        if (reserveSymbol) messariFilters.push(`asset_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
        const messariWhere = messariFilters.length > 0 ? `, where: { ${messariFilters.join(", ")} }` : "";
        const query = `{
          deposits(first: ${first}, orderBy: timestamp, orderDirection: desc${messariWhere}) {
            id
            timestamp
            account { id }
            asset { symbol name decimals }
            amount
            amountUSD
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      // V2 uses "deposit" entity, V3 uses "supply"
      const entity = cfg.version === "v2" ? "deposits" : "supplies";

      const query = `{
        ${entity}(first: ${first}, orderBy: timestamp, orderDirection: desc${where}) {
          id
          txHash
          timestamp
          user { id }
          reserve { symbol name decimals }
          amount
          referrer
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 8 — get_aave_liquidations
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_liquidations",
  {
    description:
      "Use this when the user asks about AAVE liquidation events — " +
      "'Show me recent liquidations on Ethereum', 'Has address 0x... been liquidated?', " +
      "'Who are the top liquidators on Arbitrum?', 'What collateral is being seized most?'. " +
      "Returns: liquidator address, liquidated user, collateral asset seized, " +
      "debt asset repaid, amounts, and timestamp. " +
      "Liquidations occur when a user's health factor drops below 1.0.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of liquidation events to return (1–100, default 20)"),
      userAddress: z
        .string()
        .optional()
        .describe("Optional: filter by the address that was liquidated"),
      liquidator: z
        .string()
        .optional()
        .describe("Optional: filter by liquidator address"),
    },
  },
  async ({ chain, first, userAddress, liquidator }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari schema (liquidates entity)
      if (cfg.isMessari) {
        const messariFilters: string[] = [];
        if (userAddress) messariFilters.push(`liquidatee_: { id: "${userAddress.toLowerCase()}" }`);
        if (liquidator) messariFilters.push(`liquidator_: { id: "${liquidator.toLowerCase()}" }`);
        const messariWhere = messariFilters.length > 0 ? `, where: { ${messariFilters.join(", ")} }` : "";
        const query = `{
          liquidates(first: ${first}, orderBy: timestamp, orderDirection: desc${messariWhere}) {
            id
            timestamp
            liquidator { id }
            liquidatee { id }
            asset { symbol decimals }
            amount
            amountUSD
            profitUSD
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      const filters: string[] = [];
      if (userAddress) filters.push(`user: "${userAddress.toLowerCase()}"`);
      if (liquidator)
        filters.push(`liquidator: "${liquidator.toLowerCase()}"`);
      const where =
        filters.length > 0 ? `, where: { ${filters.join(", ")} }` : "";

      const query = `{
        liquidationCalls(first: ${first}, orderBy: timestamp, orderDirection: desc${where}) {
          id
          txHash
          timestamp
          user { id }
          liquidator
          collateralReserve { symbol name decimals }
          principalReserve { symbol name decimals }
          collateralAmount
          principalAmount
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 9 — get_aave_repays
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_repays",
  {
    description:
      "Use this when the user asks about AAVE debt repayment activity — " +
      "'Show me recent repayments on Ethereum', 'Has address 0x... repaid any debt?', " +
      "'What assets are being repaid most on Arbitrum?', 'Show USDC repay history'. " +
      "Returns repay events with: repayer address, asset, raw amount, and timestamp. " +
      "Divide amount by 10^decimals for human-readable value.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of repay events to return (1–100, default 20)"),
      userAddress: z
        .string()
        .optional()
        .describe("Optional: filter by repayer address (0x...)"),
      reserveSymbol: z
        .string()
        .optional()
        .describe("Optional: filter by asset symbol (e.g. USDC, WETH, DAI)"),
    },
  },
  async ({ chain, first, userAddress, reserveSymbol }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari schema (account/asset instead of user/reserve)
      if (cfg.isMessari) {
        const messariFilters: string[] = [];
        if (userAddress) messariFilters.push(`account: "${userAddress.toLowerCase()}"`);
        if (reserveSymbol) messariFilters.push(`asset_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
        const messariWhere = messariFilters.length > 0 ? `, where: { ${messariFilters.join(", ")} }` : "";
        const query = `{
          repays(first: ${first}, orderBy: timestamp, orderDirection: desc${messariWhere}) {
            id
            timestamp
            account { id }
            asset { symbol name decimals }
            amount
            amountUSD
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      const filters: string[] = [];
      if (userAddress) filters.push(`user: "${userAddress.toLowerCase()}"`);
      if (reserveSymbol)
        filters.push(`reserve_: { symbol: "${reserveSymbol.toUpperCase()}" }`);
      const where =
        filters.length > 0 ? `, where: { ${filters.join(", ")} }` : "";

      const useATokensField = cfg.hasIsPaused !== false ? "\n          useATokens" : "";
      const query = `{
        repays(first: ${first}, orderBy: timestamp, orderDirection: desc${where}) {
          id
          txHash
          timestamp
          user { id }
          repayer
          reserve { symbol name decimals }
          amount${useATokensField}
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 10 — get_aave_flash_loans
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_flash_loans",
  {
    description:
      "Use this when the user asks about AAVE flash loans — " +
      "'Show me recent flash loans on Ethereum', 'What assets are flash-loaned most?', " +
      "'How much in flash loan fees has AAVE earned?'. " +
      "Returns: initiator address, asset borrowed, amount, fee paid (totalFee), and timestamp. " +
      "Flash loans must be borrowed and repaid within a single transaction.",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of flash loan events to return (1–100, default 20)"),
    },
  },
  async ({ chain, first }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari schema (flashloans lowercase entity)
      if (cfg.isMessari) {
        const query = `{
          flashloans(first: ${first}, orderBy: timestamp, orderDirection: desc) {
            id
            timestamp
            account { id }
            asset { symbol name decimals }
            amount
            amountUSD
            feeAmount
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      const v3Fields = cfg.hasIsPaused !== false ? "\n          lpFee\n          protocolFee" : "";
      const query = `{
        flashLoans(first: ${first}, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          initiator { id }
          reserve { symbol name decimals }
          amount
          totalFee${v3Fields}
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 10 — get_reserve_rate_history
// ---------------------------------------------------------------------------
server.registerTool(
  "get_reserve_rate_history",
  {
    description:
      "Use this when the user asks about historical AAVE rates or TVL trends — " +
      "'How has USDC supply rate changed over time?', 'Show me ETH borrow rate history on Polygon', " +
      "'What was the utilization rate last week?'. " +
      "Returns timestamped snapshots of: liquidityRate, variableBorrowRate, stableBorrowRate, " +
      "utilizationRate, availableLiquidity, totalLiquidity, totalCurrentVariableDebt. " +
      "Rates are in RAY units (divide by 1e27 * 100 for APY %). " +
      "Get the reserve ID from get_aave_reserves (the 'id' field = underlyingAsset + poolAddress).",
    inputSchema: {
      chain: z.enum(LENDING_CHAIN_NAMES).describe("Chain identifier"),
      reserveId: z
        .string()
        .describe(
          "Reserve ID — from get_aave_reserves 'id' field. " +
            "For AAVE V2/V3: concatenation of underlyingAsset + pool address (lowercase). " +
            "For Fantom (Messari): the market 'id' field (contract address) from get_aave_reserves."
        ),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(30)
        .describe("Number of historical snapshots to return (default 30)"),
    },
  },
  async ({ chain, reserveId, first }) => {
    try {
      const cfg = CHAINS[chain];

      // Fantom uses Messari schema — use marketDailySnapshots instead
      // reserveId for Fantom = market contract address (id field from get_aave_reserves)
      if (cfg.isMessari) {
        const query = `{
          marketDailySnapshots(
            first: ${first},
            orderBy: timestamp,
            orderDirection: desc,
            where: { market_: { id: "${reserveId.toLowerCase()}" } }
          ) {
            timestamp
            totalValueLockedUSD
            totalBorrowBalanceUSD
            totalDepositBalanceUSD
            rates { side type rate }
          }
        }`;
        const data = await queryChain(cfg.subgraphId, query);
        return textResult(data);
      }

      const query = `{
        reserveParamsHistoryItems(
          first: ${first},
          orderBy: timestamp,
          orderDirection: desc,
          where: { reserve: "${reserveId.toLowerCase()}" }
        ) {
          timestamp
          liquidityRate
          variableBorrowRate
          stableBorrowRate
          utilizationRate
          availableLiquidity
          totalLiquidity
          totalCurrentVariableDebt
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 11 — find_best_rates
// ---------------------------------------------------------------------------
server.registerTool(
  "find_best_rates",
  {
    description:
      "Use this when the user asks 'Where should I supply USDC for the best yield?', " +
      "'Which chain has the lowest WETH borrow rate?', " +
      "'Compare AAVE rates across chains for USDC', " +
      "'Best AAVE lending rates for DAI'. " +
      "Queries all AAVE lending deployments in parallel for the given asset, then ranks by APY. " +
      "Excludes Fantom (incompatible Messari schema) and skips anomalous pools. " +
      "Returns a ranked table with chain, supply APY, variable borrow APY, utilization, and approx available liquidity. " +
      "Includes a _recommendation field with the best option.",
    inputSchema: {
      asset: z
        .string()
        .describe(
          "Token symbol to compare, e.g. 'USDC', 'WETH', 'USDT', 'WBTC', 'DAI'. " +
            "Case-insensitive partial match (e.g. 'USDC' matches 'USDC.e')."
        ),
      side: z
        .enum(["supply", "borrow"])
        .default("supply")
        .describe(
          "'supply' = rank by highest supply APY; 'borrow' = rank by lowest variable borrow APY. Default: supply."
        ),
      minLiquidityUSD: z
        .number()
        .default(100_000)
        .describe(
          "Minimum available liquidity (approx USD) to include a market. Default $100K. Set to 0 to include all."
        ),
    },
  },
  async ({ asset, side, minLiquidityUSD }) => {
    try {
      const assetUpper = asset.toUpperCase();
      const chains = LENDING_CHAIN_NAMES.filter((n) => !CHAINS[n].isMessari);

      const query = `{
        reserves(
          where: { symbol_contains_nocase: "${assetUpper}" }
          first: 20
        ) {
          symbol
          decimals
          liquidityRate
          variableBorrowRate
          utilizationRate
          totalLiquidity
          availableLiquidity
          price { priceInEth }
        }
      }`;

      const settled = await Promise.allSettled(
        chains.map(async (chainKey) => {
          const cfg = CHAINS[chainKey];
          const data = await queryChain(cfg.subgraphId, query);
          return { chainKey, cfg, data };
        })
      );

      type Row = {
        chain: string;
        chainKey: string;
        symbol: string;
        supplyAPY: number;
        variableBorrowAPY: number;
        utilization: number;
        availLiqUSD: number;
        warning?: string;
      };

      const rows: Row[] = [];

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const { chainKey, cfg, data } = result.value;
        const reserves = (data as Record<string, unknown>)["reserves"] as
          | Array<Record<string, unknown>>
          | undefined;
        if (!reserves || reserves.length === 0) continue;

        for (const reserve of reserves) {
          const sym = reserve["symbol"] as string;
          const decimals = Number(reserve["decimals"] ?? 18);
          const supplyAPY = Number(reserve["liquidityRate"] ?? "0") / 1e27 * 100;
          const borrowAPY = Number(reserve["variableBorrowRate"] ?? "0") / 1e27 * 100;
          const util = Number(reserve["utilizationRate"] ?? "0");
          const totalLiq = Number(reserve["totalLiquidity"] ?? "0");
          const availLiq = Number(reserve["availableLiquidity"] ?? "0");
          const rawPrice = Number(
            ((reserve["price"] as Record<string, unknown>)?.["priceInEth"] as string) ?? "0"
          );
          // V3 subgraphs store oracle price as USD × 1e8 (Chainlink standard).
          // V2 subgraphs store as ETH × 1e18. Distinguish by magnitude.
          const priceUSD = cfg.version !== "v2"
            ? rawPrice / 1e8                     // V3: USD with 8 decimals
            : (rawPrice / 1e18) * 3000;          // V2: ETH with 18 decimals × ~$3k

          const availTokens = availLiq / Math.pow(10, decimals);
          const availLiqUSD = priceUSD > 0 ? availTokens * priceUSD : 0;

          let warning: string | undefined;
          if (totalLiq < 0) {
            warning = "NEGATIVE_LIQUIDITY — accounting artifact from token migration";
          } else if (util > 1.0) {
            warning = `OVER_UTILIZED (${(util * 100).toFixed(0)}%) — accounting artifact`;
          }

          rows.push({ chain: cfg.chain, chainKey, symbol: sym, supplyAPY, variableBorrowAPY: borrowAPY, utilization: util, availLiqUSD, warning });
        }
      }

      if (rows.length === 0) {
        return textResult({ message: `No AAVE markets found for '${asset}'.` });
      }

      const healthy = rows.filter((r) => !r.warning && r.availLiqUSD >= minLiquidityUSD);
      const anomalous = rows.filter((r) => !!r.warning);
      const tooSmall = rows.filter((r) => !r.warning && r.availLiqUSD < minLiquidityUSD);

      if (side === "supply") {
        healthy.sort((a, b) => b.supplyAPY - a.supplyAPY);
      } else {
        healthy.sort((a, b) => a.variableBorrowAPY - b.variableBorrowAPY);
      }

      const fmtUSD = (usd: number) =>
        usd >= 1e9 ? "$" + (usd / 1e9).toFixed(2) + "B"
        : usd >= 1e6 ? "$" + (usd / 1e6).toFixed(1) + "M"
        : usd >= 1e3 ? "$" + (usd / 1e3).toFixed(0) + "K"
        : "$" + usd.toFixed(0);

      const ranked = healthy.map((r, i) => ({
        rank: i + 1,
        chain: r.chain,
        symbol: r.symbol,
        supplyAPY: r.supplyAPY.toFixed(2) + "%",
        variableBorrowAPY: r.variableBorrowAPY.toFixed(2) + "%",
        utilization: (r.utilization * 100).toFixed(1) + "%",
        availLiq_approxUSD: fmtUSD(r.availLiqUSD),
      }));

      const response: Record<string, unknown> = {
        asset: assetUpper,
        side,
        ranked,
        _note:
          "APYs are current values from AAVE subgraphs and change continuously with utilization. " +
          "availLiq_approxUSD: V3 chains use on-chain USD oracle (8 dec); V2 uses ETH oracle × $3,000 estimate. " +
          "Fantom excluded (Messari schema incompatible). V2 legacy chains included.",
      };

      const best = ranked[0];
      if (best) {
        response["_recommendation"] =
          side === "supply"
            ? `Best supply rate: ${best.chain} ${best.symbol} at ${best.supplyAPY} APY (~${best.availLiq_approxUSD} available to deposit).`
            : `Lowest borrow rate: ${best.chain} ${best.symbol} at ${best.variableBorrowAPY} variable APY.`;
      } else {
        response["_recommendation"] = `No healthy markets found for '${asset}' meeting the liquidity threshold ($${minLiquidityUSD.toLocaleString()}).`;
      }

      if (anomalous.length > 0) {
        response["_skippedAnomalous"] = anomalous.map(
          (r) => `${r.chain} ${r.symbol}: ${r.warning}`
        );
      }
      if (tooSmall.length > 0) {
        response["_skippedLowLiquidity"] = tooSmall.map(
          (r) => `${r.chain} ${r.symbol}: ~${fmtUSD(r.availLiqUSD)} available`
        );
      }

      return textResult(response);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 12 — get_governance_proposals
// ---------------------------------------------------------------------------
server.registerTool(
  "get_governance_proposals",
  {
    description:
      "Use this when the user asks about AAVE governance — " +
      "'Show me recent AAVE governance proposals', 'What proposals are currently active?', " +
      "'What is the status of AAVE proposal #X?', 'Show me governance voting activity'. " +
      "Queries the AAVE Governance V3 subgraph on Ethereum. " +
      "Returns: proposal ID, creator, access level (1=short executor/2=long executor), " +
      "current state, voting duration (seconds), for/against votes, title, and payload info. " +
      "Proposal states: Created=0, Active=1, Queued=2, Executed=3, Failed=4, Cancelled=5, Expired=6.",
    inputSchema: {
      first: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of proposals to return (1–50, default 10)"),
      state: z
        .number()
        .optional()
        .describe(
          "Optional: filter by state number. " +
            "0=Created, 1=Active, 2=Queued, 3=Executed, 4=Failed, 5=Cancelled, 6=Expired"
        ),
    },
  },
  async ({ first, state }) => {
    try {
      const cfg = CHAINS["governance"];
      const where = state !== undefined ? `, where: { state: ${state} }` : "";
      const query = `{
        proposals(first: ${first}, orderBy: proposalId, orderDirection: desc${where}) {
          proposalId
          creator
          accessLevel
          ipfsHash
          state
          votingDuration
          snapshotBlockHash
          proposalMetadata { title }
          votes {
            forVotes
            againstVotes
          }
          payloads {
            id
            accessLevel
          }
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 13 — get_proposal_votes
// ---------------------------------------------------------------------------
server.registerTool(
  "get_proposal_votes",
  {
    description:
      "Use this when the user asks about the vote totals on a specific AAVE governance proposal — " +
      "'How did proposal #X vote?', 'Show me the for/against breakdown for proposal #185', " +
      "'Did proposal #X pass?'. " +
      "Returns aggregate vote totals: total forVotes and againstVotes for the proposal. " +
      "Note: individual per-voter records are not indexed in this subgraph.",
    inputSchema: {
      proposalId: z
        .string()
        .describe("AAVE governance proposal ID (numeric string, e.g. '185')"),
    },
  },
  async ({ proposalId }) => {
    try {
      const cfg = CHAINS["governance"];
      const query = `{
        proposalVotes_collection(
          where: { id: "${proposalId}" }
        ) {
          id
          forVotes
          againstVotes
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 13 — query_aave_subgraph
// ---------------------------------------------------------------------------
server.registerTool(
  "query_aave_subgraph",
  {
    description:
      "Use this when a pre-built tool doesn't cover the user's need — " +
      "execute a raw GraphQL query against any AAVE chain's subgraph. " +
      "Use get_aave_schema first to explore available entities and fields. " +
      "Lending schema entities: reserves, userReserves, borrows, supplies (V3) / deposits (V2), " +
      "repays, liquidationCalls, flashLoans, pool, protocol, reserveParamsHistoryItems. " +
      "Governance schema entities: proposals, proposalVotes_collection, payloads, " +
      "votingPortals, votingConfigs, proposalMetadata_collection.",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain identifier (includes 'governance')"),
      query: z.string().describe("GraphQL query string"),
      variables: z
        .record(z.unknown())
        .optional()
        .describe("Optional GraphQL variables"),
    },
  },
  async ({ chain, query, variables }) => {
    try {
      const cfg = CHAINS[chain];
      const data = await queryChain(cfg.subgraphId, query, variables);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 14 — get_aave_schema
// ---------------------------------------------------------------------------
server.registerTool(
  "get_aave_schema",
  {
    description:
      "Use this to introspect the full GraphQL schema for any AAVE chain's subgraph. " +
      "Returns all queryable root fields and their types. " +
      "Useful before writing a custom query_aave_subgraph call, or to understand " +
      "what data is available on a specific chain/version.",
    inputSchema: {
      chain: z.enum(CHAIN_NAMES).describe("Chain identifier (includes 'governance')"),
    },
  },
  async ({ chain }) => {
    try {
      const cfg = CHAINS[chain];
      const query = `{
        __schema {
          queryType {
            fields {
              name
              description
              type { name kind ofType { name kind } }
            }
          }
        }
      }`;
      const data = await queryChain(cfg.subgraphId, query);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ===========================================================================
// LIQUIDATION RISK TOOLS — 5 chains via dedicated risk subgraphs
// ===========================================================================

// ---------------------------------------------------------------------------
// Tool 15 — get_at_risk_positions
// ---------------------------------------------------------------------------
server.registerTool(
  "get_at_risk_positions",
  {
    description:
      "Find Aave positions at risk of liquidation across 5 chains. " +
      "Returns positions with health factor, risk score (0–100), risk level " +
      "(critical/danger/warning), collateral, and debt amounts. " +
      "Use when asked: 'Which positions are close to liquidation on Arbitrum?', " +
      "'Show me the riskiest Aave positions on Base', 'How many critical positions are there?'",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
      riskLevel: z
        .enum(["critical", "danger", "warning"])
        .optional()
        .describe("Filter by risk level (omit to get all non-safe positions)"),
      first: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Number of positions to return (default 25), sorted by riskScore desc"),
    },
  },
  async ({ chain, riskLevel, first }) => {
    try {
      const data = await getAtRiskPositions(chain, riskLevel, first);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 16 — get_user_risk_profile
// ---------------------------------------------------------------------------
server.registerTool(
  "get_user_risk_profile",
  {
    description:
      "Get a user's full liquidation risk profile on a specific chain — " +
      "all their positions with health factors, risk scores, collateral, and debt. " +
      "Use when asked: 'Is wallet 0x... at risk of liquidation?', " +
      "'What's the health factor for this address on Base?', " +
      "'Show me this user's risk across all their Aave positions'.",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
      userAddress: z.string().describe("Wallet address (0x...)"),
    },
  },
  async ({ chain, userAddress }) => {
    try {
      const data = await getUserRiskPositions(chain, userAddress);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 17 — get_protocol_risk_stats
// ---------------------------------------------------------------------------
server.registerTool(
  "get_protocol_risk_stats",
  {
    description:
      "Get aggregate risk statistics for Aave on a chain — total positions, " +
      "and how many are in danger, warning, or critical state. " +
      "Use when asked: 'How healthy is Aave on Ethereum right now?', " +
      "'How many positions are at risk on Arbitrum?', " +
      "'Give me a risk overview of the protocol'.",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
    },
  },
  async ({ chain }) => {
    try {
      const data = await getProtocolRiskStats(chain);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 18 — get_risk_alerts
// ---------------------------------------------------------------------------
server.registerTool(
  "get_risk_alerts",
  {
    description:
      "Get recent risk level transitions — when positions moved between " +
      "safe/warning/danger/critical states. Shows previous and new risk level, " +
      "health factor at transition, and timestamp. " +
      "Use when asked: 'Which positions recently became at risk?', " +
      "'Show me health factor drops on Polygon', " +
      "'Has wallet 0x... had any risk alerts?'.",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
      first: z.number().min(1).max(100).default(25).describe("Number of alerts (default 25)"),
      userAddress: z.string().optional().describe("Optional: filter by wallet address"),
    },
  },
  async ({ chain, first, userAddress }) => {
    try {
      const data = await getRiskAlerts(chain, first, userAddress);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 19 — get_risk_liquidations
// ---------------------------------------------------------------------------
server.registerTool(
  "get_risk_liquidations",
  {
    description:
      "Get liquidation events from the risk subgraph — includes collateral asset, " +
      "debt asset, amounts, liquidator, and transaction hash. " +
      "Complements get_aave_liquidations with risk-specific context. " +
      "Use when asked: 'Show recent liquidations on Base', " +
      "'Was this wallet liquidated?', 'What collateral was seized?'.",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
      first: z.number().min(1).max(100).default(25).describe("Number of events (default 25)"),
      userAddress: z.string().optional().describe("Optional: filter by liquidated user"),
    },
  },
  async ({ chain, first, userAddress }) => {
    try {
      const data = await getRiskLiquidations(chain, first, userAddress);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 20 — get_health_factor_history
// ---------------------------------------------------------------------------
server.registerTool(
  "get_health_factor_history",
  {
    description:
      "Get a user's health factor history over time — shows how their risk " +
      "has changed block by block. Useful for trend analysis and understanding " +
      "if a position is deteriorating. " +
      "Use when asked: 'How has this wallet's health factor changed?', " +
      "'Is this position getting riskier over time?', " +
      "'Show me the health factor trend for 0x...'.",
    inputSchema: {
      chain: z.enum(RISK_CHAIN_NAMES).describe(
        "Liquidation risk chain: risk-ethereum, risk-arbitrum, risk-base, risk-polygon, risk-optimism"
      ),
      userAddress: z.string().describe("Wallet address (0x...)"),
      first: z.number().min(1).max(200).default(50).describe("Number of snapshots (default 50)"),
    },
  },
  async ({ chain, userAddress, first }) => {
    try {
      const data = await getHealthFactorHistory(chain, userAddress, first);
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 21 — get_cross_chain_risk_summary
// ---------------------------------------------------------------------------
server.registerTool(
  "get_cross_chain_risk_summary",
  {
    description:
      "Get a cross-chain risk overview across all 5 chains (Ethereum, Arbitrum, " +
      "Base, Polygon, Optimism) in a single call. Returns protocol-level risk stats " +
      "for each chain: total positions, danger/warning/critical counts. " +
      "Use when asked: 'Which chain has the most at-risk positions?', " +
      "'Give me a risk dashboard across all chains', " +
      "'Compare Aave risk levels across networks'.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await getCrossChainRiskSummary();
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 22 — list_risk_chains
// ---------------------------------------------------------------------------
server.registerTool(
  "list_risk_chains",
  {
    description:
      "List all available liquidation risk subgraph chains with their " +
      "names, networks, subgraph IDs, and 30-day query volumes. " +
      "Use when asked: 'Which chains have liquidation risk data?', " +
      "'What risk subgraphs are available?'.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult(
        Object.entries(LIQUIDATION_RISK_CHAINS).map(([key, cfg]) => ({
          chainKey: key,
          ...cfg,
        }))
      );
    } catch (error) {
      return errorResult(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Prompts — multi-step guided workflows for any AI agent
// ---------------------------------------------------------------------------
server.registerPrompt(
  "analyze_aave_user",
  {
    description:
      "Full analysis of a wallet's AAVE position: supplied assets, borrowed assets, " +
      "estimated health factor, liquidation risk, and recent activity",
    argsSchema: {
      address: z.string().describe("Ethereum wallet address (0x...)"),
      chain: z
        .string()
        .default("ethereum")
        .describe("Chain to analyze — use list_aave_chains to see options"),
    },
  },
  ({ address, chain }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze the AAVE position of wallet ${address} on ${chain}. Steps:
1. Call get_aave_user_position(chain="${chain}", userAddress="${address}") to get all deposits and borrows
2. Identify supplied assets: those with currentATokenBalance > 0 (divide by 10^decimals)
3. Identify borrowed assets: those with currentTotalDebt > 0 (divide by 10^decimals)
4. Convert liquidityRate / variableBorrowRate from RAY (divide by 1e27 * 100) to show APY %
5. Estimate health factor: sum(collateral_i * priceEth_i * liqThreshold_i / 10000) / sum(debt_i * priceEth_i)
   (Use priceInEth from each reserve.price — already 18-decimal normalized)
6. Call get_recent_borrows(chain="${chain}", userAddress="${address}", first=5) for recent history
7. Report: total supplied, total borrowed, health factor, collateral assets, liquidation risk level`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "aave_chain_overview",
  {
    description:
      "Comprehensive overview of an AAVE deployment: top markets by TVL, " +
      "current supply/borrow rates, protocol activity, and recent liquidations",
    argsSchema: {
      chain: z
        .string()
        .default("ethereum")
        .describe("Chain to analyze (ethereum, base, arbitrum, polygon, etc.)"),
    },
  },
  ({ chain }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Give a comprehensive overview of AAVE on ${chain}. Steps:
1. Call list_aave_chains to confirm chain metadata and 30d query volume
2. Call get_aave_reserves(chain="${chain}") to get all active markets
3. Convert rates: Supply APY = liquidityRate / 1e27 * 100, Borrow APY = variableBorrowRate / 1e27 * 100
4. Identify: top 5 reserves by totalLiquidity, highest supply APY assets, highest borrow APY assets
5. Call get_recent_borrows(chain="${chain}", first=10) for latest borrowing activity
6. Call get_aave_liquidations(chain="${chain}", first=5) to check recent liquidations
7. Summarize: protocol TVL, top markets, rate opportunities, and recent activity highlights`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "compare_aave_rates",
  {
    description:
      "Compare supply APY and borrow APY for a specific asset across all supported AAVE chains",
    argsSchema: {
      symbol: z
        .string()
        .describe("Token symbol to compare — e.g. USDC, WETH, WBTC, DAI, USDT"),
    },
  },
  ({ symbol }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Compare AAVE ${symbol.toUpperCase()} rates across all chains. Steps:
1. Call list_aave_chains to see all V3 chains (focus on ethereum, base, arbitrum, polygon, optimism, avalanche first)
2. For each chain, call get_aave_reserve(chain=X, symbol="${symbol.toUpperCase()}")
3. Convert: Supply APY = liquidityRate / 1e27 * 100, Borrow APY = variableBorrowRate / 1e27 * 100
4. Also collect: totalLiquidity, availableLiquidity, utilizationRate for each chain
5. Build a comparison table: Chain | Supply APY | Variable Borrow APY | TVL | Utilization %
6. Highlight: best chain to supply ${symbol}, cheapest chain to borrow ${symbol}, and why rates differ`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "aave_liquidation_analysis",
  {
    description:
      "Monitor and analyze recent liquidations on an AAVE chain: patterns, top liquidators, at-risk assets",
    argsSchema: {
      chain: z
        .string()
        .default("ethereum")
        .describe("Chain to monitor"),
      count: z
        .string()
        .default("20")
        .describe("Number of recent liquidations to analyze"),
    },
  },
  ({ chain, count }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Analyze recent liquidations on AAVE ${chain}. Steps:
1. Call get_aave_liquidations(chain="${chain}", first=${count}) to get recent liquidation events
2. Tally: which collateral assets were most commonly seized, which debt assets were most repaid
3. Identify the top liquidators by frequency and total volume
4. Call get_aave_reserves(chain="${chain}") to check current LTV and liquidation thresholds for top collateral assets
5. Identify: which markets currently have high utilization (>80%) or low health buffers
6. Summarize: liquidation frequency, most at-risk asset pairs, top liquidators, and market risk indicators`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "aave_governance_overview",
  {
    description:
      "Overview of AAVE governance: recent proposals, voting results, and active/pending decisions",
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Give me an overview of AAVE governance activity. Steps:
1. Call get_governance_proposals(first=10) to get the 10 most recent proposals
2. For each proposal, note: proposalId, title, creator, state (0=Created,1=Active,2=Queued,3=Executed,4=Failed), for/against votes
3. Identify any currently Active (state=1) or Queued (state=2) proposals
4. For the most voted proposal, call get_proposal_votes(proposalId=X, first=10) to show top voters and their voting power
5. Summarize: recent governance decisions, current active votes, and overall governance participation`,
        },
      },
    ],
  })
);

// ===========================================================================
// Aave V4 Tools — powered by AaveKit GraphQL API (api.aave.com)
// No API key needed. V4 is not yet live — tools will return a helpful
// message until the API is reachable, then work automatically.
// When V4 subgraphs ship on The Graph, these can be migrated by adding
// entries to subgraphs.ts.
// ===========================================================================

// Tool 16: get_v4_hubs
server.registerTool("get_v4_hubs", {
  description: "Get Aave V4 liquidity hubs (Core, Plus, Prime) with TVL, utilization, and supply/borrow caps. No API key needed.",
  inputSchema: { chainId: z.number().optional().describe("Chain ID (1=Ethereum). Defaults to Ethereum.") },
}, async ({ chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4Hubs(chainId) }); } catch (e) { return errorResult(e); } });

// Tool 17: get_v4_spokes
server.registerTool("get_v4_spokes", {
  description: "Get Aave V4 spokes (Main, Bluechip, Kelp, Lido, Ethena, EtherFi, etc.). Spokes are chain-specific deployment points enabling cross-chain lending. No API key needed.",
  inputSchema: { chainId: z.number().optional().describe("Chain ID. Defaults to Ethereum.") },
}, async ({ chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4Spokes(chainId) }); } catch (e) { return errorResult(e); } });

// Tool 18: get_v4_reserves
server.registerTool("get_v4_reserves", {
  description: "Get Aave V4 reserves with supply/borrow APYs, risk params (collateral factor, caps), and status. Use get_aave_reserves for V2/V3. No API key needed.",
  inputSchema: { chainId: z.number().optional().describe("Chain ID. Defaults to Ethereum.") },
}, async ({ chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4Reserves(chainId) }); } catch (e) { return errorResult(e); } });

// Tool 19: get_v4_chains
server.registerTool("get_v4_chains", {
  description: "List all chains supported by Aave V4 (mainnet and testnet). No API key needed.",
  inputSchema: {},
}, async () => { try { return textResult({ source: "aave-v4-api", data: await getV4Chains() }); } catch (e) { return errorResult(e); } });

// Tool 20: get_v4_exchange_rate
server.registerTool("get_v4_exchange_rate", {
  description: "Get exchange rate for any token via Aave V4's Chainlink oracle integration. Supports ERC-20 tokens, native tokens (ETH), and fiat currencies. No API key needed.",
  inputSchema: {
    tokenAddress: z.string().optional().describe("ERC-20 token address (e.g. WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)"),
    chainId: z.number().default(1).describe("Chain ID for the token"),
    native: z.boolean().optional().describe("Set true to get native token (ETH) price instead of ERC-20"),
    to: z.string().default("USD").describe("Target currency: USD, EUR, or GBP"),
  },
}, async ({ tokenAddress, chainId, native, to }) => {
  try {
    const from = native ? { type: "native" as const, chainId } : { type: "erc20" as const, chainId, address: tokenAddress! };
    return textResult({ source: "aave-v4-api", data: await getV4ExchangeRate(from, to) });
  } catch (e) { return errorResult(e); }
});

// Tool 21: get_v4_asset
server.registerTool("get_v4_asset", {
  description: "Get Aave V4 asset details: total supplied/borrowed across all hubs, average supply/borrow APY, and current price. No API key needed.",
  inputSchema: {
    tokenAddress: z.string().describe("ERC-20 token contract address"),
    chainId: z.number().default(1).describe("Chain ID"),
  },
}, async ({ tokenAddress, chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4Asset(tokenAddress, chainId) }); } catch (e) { return errorResult(e); } });

// Tool 22: get_v4_asset_price_history
server.registerTool("get_v4_asset_price_history", {
  description: "Get historical price data for an Aave V4 asset. Powered by Chainlink oracles. No API key needed.",
  inputSchema: {
    tokenAddress: z.string().describe("ERC-20 token contract address"),
    chainId: z.number().default(1).describe("Chain ID"),
    window: z.enum(["LAST_DAY", "LAST_WEEK", "LAST_MONTH"]).default("LAST_WEEK").describe("Time window"),
  },
}, async ({ tokenAddress, chainId, window }) => { try { return textResult({ source: "aave-v4-api", data: await getV4AssetPriceHistory(tokenAddress, chainId, window) }); } catch (e) { return errorResult(e); } });

// Tool 23: get_v4_protocol_history
server.registerTool("get_v4_protocol_history", {
  description: "Get Aave V4 protocol-wide historical data: total deposits and borrows over time in USD. No API key needed.",
  inputSchema: {
    window: z.enum(["LAST_DAY", "LAST_WEEK", "LAST_MONTH"]).default("LAST_WEEK").describe("Time window"),
  },
}, async ({ window }) => { try { return textResult({ source: "aave-v4-api", data: await getV4ProtocolHistory(window) }); } catch (e) { return errorResult(e); } });

// Tool 24: get_v4_user_positions
server.registerTool("get_v4_user_positions", {
  description: "Get a user's Aave V4 positions across all spokes — health factor, collateral, debt, borrowing power, net APY. Cross-chain by default. No API key needed.",
  inputSchema: { userAddress: z.string().describe("EVM wallet address (0x...)") },
}, async ({ userAddress }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserPositions(userAddress) }); } catch (e) { return errorResult(e); } });

// Tool 25: get_v4_user_summary
server.registerTool("get_v4_user_summary", {
  description: "Get aggregated Aave V4 portfolio summary for a user: total positions, net balance, collateral, debt, net APY, lowest health factor. No API key needed.",
  inputSchema: { userAddress: z.string().describe("EVM wallet address (0x...)") },
}, async ({ userAddress }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserSummary(userAddress) }); } catch (e) { return errorResult(e); } });

// Tool 26: get_v4_user_supplies
server.registerTool("get_v4_user_supplies", {
  description: "Get a user's Aave V4 supply positions with principal, interest, and collateral status. No API key needed.",
  inputSchema: {
    userAddress: z.string().describe("EVM wallet address (0x...)"),
    chainId: z.number().optional().describe("Filter by chain ID"),
  },
}, async ({ userAddress, chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserSupplies(userAddress, chainId) }); } catch (e) { return errorResult(e); } });

// Tool 27: get_v4_user_borrows
server.registerTool("get_v4_user_borrows", {
  description: "Get a user's Aave V4 borrow positions with principal, debt, interest. No API key needed.",
  inputSchema: {
    userAddress: z.string().describe("EVM wallet address (0x...)"),
    chainId: z.number().optional().describe("Filter by chain ID"),
  },
}, async ({ userAddress, chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserBorrows(userAddress, chainId) }); } catch (e) { return errorResult(e); } });

// Tool 28: get_v4_user_balances
server.registerTool("get_v4_user_balances", {
  description: "Get a user's cross-chain token balances in Aave V4 with highest supply APY and lowest borrow APY per token. No API key needed.",
  inputSchema: { userAddress: z.string().describe("EVM wallet address (0x...)") },
}, async ({ userAddress }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserBalances(userAddress) }); } catch (e) { return errorResult(e); } });

// Tool 29: get_v4_user_activities
server.registerTool("get_v4_user_activities", {
  description: "Get a user's Aave V4 transaction history: supplies, borrows, withdrawals, repayments, liquidations, swaps. No API key needed.",
  inputSchema: {
    userAddress: z.string().describe("EVM wallet address (0x...)"),
    chainId: z.number().optional().describe("Filter by chain ID"),
  },
}, async ({ userAddress, chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4UserActivities(userAddress, chainId) }); } catch (e) { return errorResult(e); } });

// Tool 30: get_v4_claimable_rewards
server.registerTool("get_v4_claimable_rewards", {
  description: "Get a user's claimable Merkl and points rewards on Aave V4. No API key needed.",
  inputSchema: {
    userAddress: z.string().describe("EVM wallet address (0x...)"),
    chainId: z.number().default(1).describe("Chain ID"),
  },
}, async ({ userAddress, chainId }) => { try { return textResult({ source: "aave-v4-api", data: await getV4ClaimableRewards(userAddress, chainId) }); } catch (e) { return errorResult(e); } });

// Tool 31: get_v4_swap_quote
server.registerTool("get_v4_swap_quote", {
  description: "Get a read-only swap price quote from Aave V4 (powered by CoW Protocol with MEV protection). Returns pricing, fees, and slippage. No API key needed.",
  inputSchema: {
    sellTokenAddress: z.string().describe("Token to sell (ERC-20 address)"),
    buyTokenAddress: z.string().describe("Token to buy (ERC-20 address)"),
    sellAmount: z.string().describe("Amount to sell (human-readable, e.g. '100.5')"),
    userAddress: z.string().describe("User's wallet address"),
    chainId: z.number().default(1).describe("Chain ID"),
  },
}, async ({ sellTokenAddress, buyTokenAddress, sellAmount, userAddress, chainId }) => {
  try {
    return textResult({ source: "aave-v4-api", data: await getV4SwapQuote(
      { chainId, address: sellTokenAddress }, { chainId, address: buyTokenAddress }, sellAmount, userAddress
    ) });
  } catch (e) { return errorResult(e); }
});

// ---------------------------------------------------------------------------
// Prompt: cross_chain_risk_monitor
// ---------------------------------------------------------------------------
server.registerPrompt(
  "cross_chain_risk_monitor",
  {
    description:
      "Monitor Aave liquidation risk across all 5 chains — identify the riskiest " +
      "positions, recent risk alerts, and protocol health per network",
    argsSchema: {
      userAddress: z.string().optional().describe("Optional: focus on a specific wallet's risk across chains"),
    },
  },
  ({ userAddress }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Perform a cross-chain Aave liquidation risk analysis:
1. Call get_cross_chain_risk_summary to get protocol-level stats across all 5 chains
2. Identify which chain has the most critical/danger positions
3. On the riskiest chain, call get_at_risk_positions(riskLevel="critical") to see the worst positions
4. Call get_risk_alerts on that chain to see recent health factor transitions
${userAddress ? `5. For wallet ${userAddress}:
   - Call get_user_risk_profile on each chain to check their positions
   - Call get_health_factor_history on chains where they have positions
   - Assess: is this wallet at risk? Is their health factor trending down?` : ""}
Summarize: total at-risk positions per chain, the most critical positions, recent risk movements, ${userAddress ? "and this wallet's risk profile" : "and recommended monitoring priorities"}.`,
        },
      },
    ],
  })
);

// ---------------------------------------------------------------------------
// Prompt: aave_full_stack_analysis (combines V2/V3 subgraphs + V4 API)
// ---------------------------------------------------------------------------
server.registerPrompt(
  "aave_full_stack_analysis",
  {
    description:
      "Full-stack Aave analysis combining V2/V3 subgraph data with V4 API data — compare rates, positions, and liquidity across all versions",
    argsSchema: {
      userAddress: z.string().optional().describe("Optional user address to analyze positions across V2/V3/V4"),
    },
  },
  ({ userAddress }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Do a full-stack Aave analysis across V2, V3, and V4. Follow these steps:
1. Call get_v4_hubs to see V4's cross-chain liquidity hubs
2. Call get_v4_reserves to get V4 supply/borrow rates and utilization
3. Call get_aave_reserves(chain="ethereum") to get V3 Ethereum rates for comparison
4. Compare V3 vs V4: which version has better supply APY for major assets (USDC, ETH, WBTC)?
5. Call get_v4_spokes to understand V4's cross-chain deployment topology
${userAddress ? `6. Call get_v4_user_positions(userAddress="${userAddress}") for their V4 positions
7. Call get_aave_user_position(chain="ethereum", userAddress="${userAddress}") for their V3 positions
8. Compare: which version has better rates for this user's specific assets?` : ""}
Summarize: V4 hub/spoke architecture overview, rate comparison V3 vs V4, liquidity distribution, ${userAddress ? "and user position analysis across versions" : "and migration opportunities"}`,
        },
      },
    ],
  })
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Graph AAVE MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
