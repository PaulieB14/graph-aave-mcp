#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryChain } from "./graphClient.js";
import { CHAINS, CHAIN_NAMES, LENDING_CHAIN_NAMES } from "./subgraphs.js";

const server = new McpServer({
  name: "graph-aave-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
        return textResult(data);
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
      return textResult(data);
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
        return textResult(data);
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
      return textResult(data);
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
      return textResult(data);
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
// Tool 11 — get_governance_proposals
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
// Tool 12 — get_proposal_votes
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
