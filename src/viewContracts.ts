/**
 * Live on-chain reads against Aave V3 view contracts.
 *
 * Why live reads alongside subgraph data: subgraphs lag chainhead.
 * For risk monitoring, "HF was 1.05 at last index" can be a dangerous
 * false-negative when the live value is 0.998 and a liquidation bot is
 * already racing. Every response here carries an `as_of.block` stamp so
 * agents can detect stale data after context compaction.
 */

import { parseAbi, getAddress } from "viem";
import { rpcClient, rpcAddresses, rpcChainId } from "./rpcClient.js";

/** Coerce any 0x-prefixed hex (mixed/lower/upper) to checksummed form viem accepts. */
function addr(input: string): `0x${string}` {
  return getAddress(input.toLowerCase());
}

// ── Minimal ABIs for contracts not re-exported by /abis ─────────────────────

const POOL_GET_USER_ACCOUNT_DATA_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const PROTOCOL_DATA_PROVIDER_ABI = parseAbi([
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
  "function getReserveCaps(address asset) view returns (uint256 borrowCap, uint256 supplyCap)",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Wrap a payload with `as_of` block + timestamp so future readers (post-compaction) can spot stale data. */
async function stampAsOf<T>(chainKey: string, data: T): Promise<{
  data: T;
  as_of: {
    chain: string;
    chainId: number;
    block: string;
    timestamp: string;
    source: "rpc";
  };
}> {
  const client = rpcClient(chainKey);
  const block = await client.getBlock();
  return {
    data,
    as_of: {
      chain: chainKey,
      chainId: rpcChainId(chainKey),
      block: block.number.toString(),
      timestamp: block.timestamp.toString(),
      source: "rpc",
    },
  };
}

/** BigInt → decimal string with N decimals (no rounding loss for display). */
function fmtUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Live `Pool.getUserAccountData` — the canonical current-block health factor.
 * Use this to confirm subgraph-reported risk before reporting "critical".
 *
 * Base units: 8 decimals (Aave V3 standard).
 * Health factor: 18 decimals.
 */
export async function getLiveUserAccountData(
  chainKey: string,
  userAddress: string
) {
  const client = rpcClient(chainKey);
  const { POOL } = rpcAddresses(chainKey);

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = await client.readContract({
    address: POOL,
    abi: POOL_GET_USER_ACCOUNT_DATA_ABI,
    functionName: "getUserAccountData",
    args: [addr(userAddress)],
  });

  const healthFactorNumeric =
    healthFactor === (2n ** 256n - 1n)
      ? "infinity"
      : fmtUnits(healthFactor, 18);

  return stampAsOf(chainKey, {
    user: userAddress,
    pool: POOL,
    totalCollateralBase: totalCollateralBase.toString(),
    totalCollateralBaseHuman: fmtUnits(totalCollateralBase, 8),
    totalDebtBase: totalDebtBase.toString(),
    totalDebtBaseHuman: fmtUnits(totalDebtBase, 8),
    availableBorrowsBase: availableBorrowsBase.toString(),
    availableBorrowsBaseHuman: fmtUnits(availableBorrowsBase, 8),
    currentLiquidationThreshold: currentLiquidationThreshold.toString(),
    currentLiquidationThresholdPct: `${Number(currentLiquidationThreshold) / 100}%`,
    ltv: ltv.toString(),
    ltvPct: `${Number(ltv) / 100}%`,
    healthFactor: healthFactor.toString(),
    healthFactorHuman: healthFactorNumeric,
    note:
      "Base units are 8-decimal USD-pegged (Aave V3 standard). " +
      "Health factor < 1.0 means liquidatable. " +
      "healthFactor='infinity' means no debt.",
  });
}

/**
 * Live per-asset reserve data via AaveProtocolDataProvider — current rates,
 * indexes, debt totals, plus config (LTV, liq threshold, caps).
 */
export async function getLiveReserveDetail(
  chainKey: string,
  assetAddress: string
) {
  const client = rpcClient(chainKey);
  const { AAVE_PROTOCOL_DATA_PROVIDER } = rpcAddresses(chainKey);
  const asset = addr(assetAddress);

  const [data, config, tokens, caps] = await Promise.all([
    client.readContract({
      address: AAVE_PROTOCOL_DATA_PROVIDER,
      abi: PROTOCOL_DATA_PROVIDER_ABI,
      functionName: "getReserveData",
      args: [asset],
    }),
    client.readContract({
      address: AAVE_PROTOCOL_DATA_PROVIDER,
      abi: PROTOCOL_DATA_PROVIDER_ABI,
      functionName: "getReserveConfigurationData",
      args: [asset],
    }),
    client.readContract({
      address: AAVE_PROTOCOL_DATA_PROVIDER,
      abi: PROTOCOL_DATA_PROVIDER_ABI,
      functionName: "getReserveTokensAddresses",
      args: [asset],
    }),
    client
      .readContract({
        address: AAVE_PROTOCOL_DATA_PROVIDER,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: "getReserveCaps",
        args: [asset],
      })
      .catch(() => [0n, 0n] as readonly [bigint, bigint]),
  ]);

  const [
    unbacked,
    accruedToTreasuryScaled,
    totalAToken,
    totalStableDebt,
    totalVariableDebt,
    liquidityRate,
    variableBorrowRate,
    stableBorrowRate,
    averageStableBorrowRate,
    liquidityIndex,
    variableBorrowIndex,
    lastUpdateTimestamp,
  ] = data;

  const [
    decimals,
    ltv,
    liquidationThreshold,
    liquidationBonus,
    reserveFactor,
    usageAsCollateralEnabled,
    borrowingEnabled,
    stableBorrowRateEnabled,
    isActive,
    isFrozen,
  ] = config;

  const [aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress] = tokens;
  const [borrowCap, supplyCap] = caps;

  const rayToApyPct = (r: bigint) =>
    `${(Number(r) / 1e27 * 100).toFixed(4)}%`;

  return stampAsOf(chainKey, {
    asset,
    state: {
      unbacked: unbacked.toString(),
      accruedToTreasuryScaled: accruedToTreasuryScaled.toString(),
      totalAToken: totalAToken.toString(),
      totalStableDebt: totalStableDebt.toString(),
      totalVariableDebt: totalVariableDebt.toString(),
      liquidityRate: liquidityRate.toString(),
      supplyApy: rayToApyPct(liquidityRate),
      variableBorrowRate: variableBorrowRate.toString(),
      variableBorrowApy: rayToApyPct(variableBorrowRate),
      stableBorrowRate: stableBorrowRate.toString(),
      stableBorrowApy: rayToApyPct(stableBorrowRate),
      averageStableBorrowRate: averageStableBorrowRate.toString(),
      liquidityIndex: liquidityIndex.toString(),
      variableBorrowIndex: variableBorrowIndex.toString(),
      lastUpdateTimestamp: Number(lastUpdateTimestamp),
    },
    config: {
      decimals: Number(decimals),
      ltv: ltv.toString(),
      ltvPct: `${Number(ltv) / 100}%`,
      liquidationThreshold: liquidationThreshold.toString(),
      liquidationThresholdPct: `${Number(liquidationThreshold) / 100}%`,
      liquidationBonus: liquidationBonus.toString(),
      reserveFactor: reserveFactor.toString(),
      usageAsCollateralEnabled,
      borrowingEnabled,
      stableBorrowRateEnabled,
      isActive,
      isFrozen,
    },
    tokens: {
      aToken: aTokenAddress,
      stableDebtToken: stableDebtTokenAddress,
      variableDebtToken: variableDebtTokenAddress,
    },
    caps: {
      borrowCap: borrowCap.toString(),
      supplyCap: supplyCap.toString(),
    },
  });
}

