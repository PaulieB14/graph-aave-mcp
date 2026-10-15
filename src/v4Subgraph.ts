// Aave V4 subgraph tools — network-aware (Base default, Ethereum optional).
//
// Base:     subgraph 9x1tg7KX3RXspnK7R1mahAZsM5gTmFhLrmJSbkoBsDdq
//           (Coinbase tokenized-stocks hub; deployment QmUVNhjnrUfzYyKwkKFo3Sm8nD8hU5EzGFQSb1weWY4k94)
// Ethereum: deployment QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs (Core/Plus/Prime)
//
// Everything here is data the official Aave V4 API doesn't expose: liquidation
// detail, hub asset fee accounting, config-change history, hub<->spoke daily
// flows, risk-premium history and treasury events.

import { queryChain, querySubgraphId } from "./graphClient.js";

export type V4Network = "base" | "ethereum";

export const V4_NETWORKS: Record<V4Network, { kind: "subgraph" | "deployment"; id: string; chainId: number }> = {
  base: {
    kind: "subgraph",
    id: process.env.AAVE_V4_BASE_SUBGRAPH_ID || "9x1tg7KX3RXspnK7R1mahAZsM5gTmFhLrmJSbkoBsDdq",
    chainId: 8453,
  },
  ethereum: {
    kind: "deployment",
    id: process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID || "QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs",
    chainId: 1,
  },
};

async function q<T>(network: V4Network, query: string, vars?: Record<string, unknown>): Promise<T> {
  const n = V4_NETWORKS[network];
  return (n.kind === "subgraph"
    ? await querySubgraphId(n.id, query, vars)
    : await queryChain(n.id, query, vars)) as T;
}

function source(network: V4Network) {
  const n = V4_NETWORKS[network];
  return { network, chainId: n.chainId, [n.kind === "subgraph" ? "subgraphId" : "deployment"]: n.id };
}

const lc = (s?: string) => (s ? s.toLowerCase() : undefined);
const RAY = 10n ** 27n;
/** ray-per-second or ray-annual? V4 drawnRate is an annualised ray. */
function rayToPct(v: string | null | undefined): number | null {
  if (v == null) return null;
  try {
    return Number((BigInt(v) * 1000000n) / RAY) / 10000;
  } catch {
    return null;
  }
}
function fmt(v: string | null | undefined, decimals: number | null | undefined): string | null {
  if (v == null || decimals == null) return null;
  const neg = v.startsWith("-");
  const s = (neg ? v.slice(1) : v).padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + i + (f ? "." + f : "");
}
function since(sinceHours?: number): string {
  return sinceHours ? String(Math.floor(Date.now() / 1000 - sinceHours * 3600)) : "0";
}
type Meta = { _meta?: { block?: { number: number } } };
const META = "_meta { block { number } }";

// --- 1. Recent liquidations ------------------------------------------------
export async function getRecentLiquidations(a: {
  network: V4Network; liquidator?: string; user?: string; sinceHours?: number; limit?: number;
}) {
  const where: string[] = ["timestamp_gte: $since"];
  if (a.liquidator) where.push("liquidator: $liquidator");
  if (a.user) where.push("user: $user");
  const query = `query Q($limit: Int!, $since: BigInt!${a.liquidator ? ", $liquidator: Bytes!" : ""}${a.user ? ", $user: String!" : ""}) {
    ${META}
    liquidationCalls(first: $limit, orderBy: timestamp, orderDirection: desc, where: { ${where.join(", ")} }) {
      txHash timestamp block liquidator receiveShares
      user { id }
      spoke { id }
      collateralReserve { id reserveId assetId }
      debtReserve { id reserveId assetId }
      debtAmountRestored drawnSharesLiquidated collateralAmountRemoved
      collateralSharesLiquidated collateralSharesToLiquidator
      premiumSharesDelta premiumOffsetRayDelta restoredPremiumRay
    }
  }`;
  const d = await q<Meta & { liquidationCalls: any[] }>(a.network, query, {
    limit: Math.min(a.limit ?? 25, 200), since: since(a.sinceHours),
    ...(a.liquidator ? { liquidator: lc(a.liquidator) } : {}),
    ...(a.user ? { user: lc(a.user) } : {}),
  });
  const byLiquidator: Record<string, number> = {};
  for (const l of d.liquidationCalls) byLiquidator[l.liquidator] = (byLiquidator[l.liquidator] ?? 0) + 1;
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null,
    count: d.liquidationCalls.length, byLiquidator,
    liquidations: d.liquidationCalls.map((l) => ({ ...l, user: l.user?.id, spoke: l.spoke?.id,
      date: new Date(Number(l.timestamp) * 1000).toISOString() })),
  };
}

// --- 2. Hub assets: rates + fees -------------------------------------------
export async function getHubAssets(a: { network: V4Network; hub?: string }) {
  const query = `query Q${a.hub ? "($hub: String!)" : ""} {
    ${META}
    hubAssets(first: 200, orderBy: assetId, where: { ${a.hub ? "hub: $hub" : ""} }) {
      id assetId underlying decimals liquidityFee drawnRate drawnIndex accruedFees
      feeReceiver irStrategy reinvestmentController lastUpdatedBlock
      hub { id name }
    }
  }`;
  const d = await q<Meta & { hubAssets: any[] }>(a.network, query, a.hub ? { hub: lc(a.hub) } : undefined);
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null,
    assets: d.hubAssets.map((h) => ({
      hub: h.hub?.name ?? h.hub?.id, hubAddress: h.hub?.id, assetId: h.assetId, underlying: h.underlying,
      decimals: h.decimals, borrowRatePct: rayToPct(h.drawnRate), liquidityFeePct: h.liquidityFee / 100,
      accruedFees: fmt(h.accruedFees, h.decimals), accruedFeesRaw: h.accruedFees, drawnRateRay: h.drawnRate,
      drawnIndex: h.drawnIndex, feeReceiver: h.feeReceiver, irStrategy: h.irStrategy,
      reinvestmentController: h.reinvestmentController, lastUpdatedBlock: h.lastUpdatedBlock,
    })),
  };
}

// --- 3. Config change history ----------------------------------------------
export async function getConfigChanges(a: { network: V4Network; spoke?: string; limit?: number }) {
  const limit = Math.min(a.limit ?? 25, 200);
  const sp = a.spoke ? lc(a.spoke) : undefined;
  const query = `query Q($limit: Int!${sp ? ", $spoke: String!" : ""}) {
    ${META}
    hubSpokeConfigSnapshots(first: $limit, orderBy: block, orderDirection: desc${sp ? ", where: { config_: { spoke: $spoke } }" : ""}) {
      addCap drawCap riskPremiumThreshold active halted block timestamp txHash
      config { id spoke { id } hubAsset { assetId underlying } }
    }
    reserveConfigSnapshots(first: $limit, orderBy: block, orderDirection: desc${sp ? ", where: { reserve_: { spoke: $spoke } }" : ""}) {
      collateralRisk paused frozen borrowable receiveSharesEnabled block timestamp txHash
      reserve { id reserveId assetId spoke { id } }
    }
    spokeLiquidationConfigSnapshots(first: $limit, orderBy: block, orderDirection: desc${sp ? ", where: { config_: { spoke: $spoke } }" : ""}) {
      targetHealthFactor healthFactorForMaxBonus liquidationBonusFactor block timestamp txHash
      config { spoke { id } }
    }
    spokePositionManagerWhitelists(first: $limit, orderBy: updatedAtBlock, orderDirection: desc${sp ? ", where: { spoke: $spoke }" : ""}) {
      positionManager active updatedAtBlock updatedAtTx spoke { id }
    }
  }`;
  const d = await q<Meta & Record<string, any[]>>(a.network, query, { limit, ...(sp ? { spoke: sp } : {}) });
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null,
    hubSpokeConfigChanges: d.hubSpokeConfigSnapshots,
    reserveConfigChanges: d.reserveConfigSnapshots,
    liquidationConfigChanges: d.spokeLiquidationConfigSnapshots,
    positionManagerWhitelist: d.spokePositionManagerWhitelists,
  };
}

// --- 4. Hub<->spoke flows (daily + raw) ------------------------------------
export async function getHubDailyFlows(a: { network: V4Network; underlying?: string; days?: number; includeRaw?: boolean; limit?: number }) {
  const days = Math.min(a.days ?? 30, 365);
  const fromDay = Math.floor(Date.now() / 86400000) - days;
  const u = a.underlying ? lc(a.underlying) : undefined;
  const limit = Math.min(a.limit ?? 20, 200);
  const query = `query Q($fromDay: Int!, $limit: Int!${u ? ", $u: Bytes!" : ""}) {
    ${META}
    hubAssetDailies(first: 1000, orderBy: day, orderDirection: desc, where: { day_gte: $fromDay${u ? ", hubAsset_: { underlying: $u }" : ""} }) {
      day flowCount totalAddedAmount totalRemovedAmount totalDrawnAmount totalRestoredAmount totalDeficitRay
      hubAsset { assetId underlying decimals }
    }
    ${a.includeRaw ? `hubSpokeFlows(first: $limit, orderBy: timestamp, orderDirection: desc${u ? ", where: { hubAsset_: { underlying: $u } }" : ""}) {
      type amount shares drawnAmount premiumAmount timestamp txHash spoke { id } hubAsset { assetId underlying decimals }
    }` : ""}
  }`;
  const d = await q<Meta & { hubAssetDailies: any[]; hubSpokeFlows?: any[] }>(a.network, query, { fromDay, limit, ...(u ? { u } : {}) });
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null,
    daily: d.hubAssetDailies.map((r) => {
      const dec = r.hubAsset?.decimals;
      return {
        date: new Date(r.day * 86400000).toISOString().slice(0, 10), assetId: r.hubAsset?.assetId,
        underlying: r.hubAsset?.underlying, flowCount: r.flowCount,
        supplied: fmt(r.totalAddedAmount, dec), withdrawn: fmt(r.totalRemovedAmount, dec),
        borrowed: fmt(r.totalDrawnAmount, dec), repaid: fmt(r.totalRestoredAmount, dec),
        deficitRay: r.totalDeficitRay,
      };
    }),
    ...(d.hubSpokeFlows ? { recentFlows: d.hubSpokeFlows } : {}),
  };
}

// --- 5. User risk premium + activity ---------------------------------------
export async function getUserActivity(a: { network: V4Network; user: string; limit?: number }) {
  const user = lc(a.user)!;
  const limit = Math.min(a.limit ?? 25, 200);
  const query = `query Q($user: ID!, $u: String!, $limit: Int!) {
    ${META}
    user(id: $user) {
      latestRiskPremium latestRiskPremiumSpoke { id }
      riskPremiumHistory(first: $limit, orderBy: block, orderDirection: desc) { riskPremium spoke { id } block timestamp txHash }
      liquidationsAsUser(first: $limit, orderBy: timestamp, orderDirection: desc) { txHash timestamp liquidator debtAmountRestored collateralAmountRemoved }
    }
    userActivities(first: $limit, orderBy: timestamp, orderDirection: desc, where: { user: $u }) {
      type amount shares totalAmountRepaid usingAsCollateral caller timestamp txHash
      spoke { id } reserve { reserveId assetId }
    }
  }`;
  const d = await q<Meta & { user: any; userActivities: any[] }>(a.network, query, { user, u: user, limit });
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null, user,
    found: Boolean(d.user) || d.userActivities.length > 0,
    latestRiskPremium: d.user?.latestRiskPremium ?? null,
    latestRiskPremiumSpoke: d.user?.latestRiskPremiumSpoke?.id ?? null,
    riskPremiumHistory: d.user?.riskPremiumHistory ?? [],
    liquidations: d.user?.liquidationsAsUser ?? [],
    activities: d.userActivities,
  };
}

// --- 6. Treasury events ----------------------------------------------------
export async function getTreasuryEvents(a: { network: V4Network; sinceHours?: number; limit?: number }) {
  const limit = Math.min(a.limit ?? 25, 200);
  const query = `query Q($limit: Int!, $since: BigInt!) {
    ${META}
    feeMints(first: $limit, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) { feeReceiver shares assets timestamp txHash hubAsset { assetId underlying decimals } }
    sweeps(first: $limit, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) { reinvestmentController amount timestamp txHash hubAsset { assetId underlying decimals } }
    reclaims(first: $limit, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) { reinvestmentController amount timestamp txHash hubAsset { assetId underlying decimals } }
    deficitEliminateds(first: $limit, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) { shares deficitAmountRay timestamp txHash callerSpoke { id } coveredSpoke { id } hubAsset { assetId underlying decimals } }
    spokeReportedDeficits(first: $limit, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) { drawnShares timestamp txHash spoke { id } user { id } reserve { reserveId assetId } }
  }`;
  const d = await q<Meta & Record<string, any[]>>(a.network, query, { limit, since: since(a.sinceHours) });
  const tag = (type: string, rows: any[]) => rows.map((r) => ({ type, ...r,
    amountFormatted: fmt(r.assets ?? r.amount, r.hubAsset?.decimals) }));
  const events = [
    ...tag("FeeMint", d.feeMints), ...tag("Sweep", d.sweeps), ...tag("Reclaim", d.reclaims),
    ...tag("DeficitEliminated", d.deficitEliminateds), ...tag("ReportDeficit", d.spokeReportedDeficits),
  ].sort((x, y) => Number(y.timestamp) - Number(x.timestamp)).slice(0, limit);
  return {
    ...source(a.network), syncedBlock: d._meta?.block?.number ?? null,
    counts: { feeMints: d.feeMints.length, sweeps: d.sweeps.length, reclaims: d.reclaims.length,
      deficitEliminateds: d.deficitEliminateds.length, reportedDeficits: d.spokeReportedDeficits.length },
    events,
  };
}
