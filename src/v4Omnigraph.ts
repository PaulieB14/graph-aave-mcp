// Aave V4 Omnigraph subgraph — high-value data AaveKit's REST API doesn't expose:
//   • Per-user risk-premium trajectory
//   • Liquidation post-mortems with full premium-delta context
//   • Treasury / fee-share / deficit flows
//   • Spoke + reserve config governance history
//
// Decentralized network deployment: QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs
// Queried through gateway via GRAPH_API_KEY (see graphClient.ts).

import { queryChain } from "./graphClient.js";

const DEPLOYMENT_ID =
  process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID ||
  "QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs";

// Hub addresses (same set v4HubFlows.ts uses; kept here so callers can filter
// by hub name without touching the older file's exports).
const HUB_ADDRESS: Record<string, string> = {
  Core: "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9",
  Plus: "0x06002e9c4412cb7814a791ea3666d905871e536a",
  Prime: "0x943827dca022d0f354a8a8c332da1e5eb9f9f931",
};

interface MetaBlock {
  _meta?: { block?: { number: number } };
}

// ---------------------------------------------------------------------------
// 1. User risk-premium trajectory
// ---------------------------------------------------------------------------

export interface UserRiskTrajectoryArgs {
  userAddress: string;
  limit?: number;
}

export interface UserRiskSnapshot {
  riskPremium: string;
  spoke: string;
  block: number;
  timestamp: number;
  txHash: string;
}

export interface UserRiskTrajectoryResult {
  user: string;
  latestRiskPremium: string | null;
  latestRiskPremiumSpoke: string | null;
  history: UserRiskSnapshot[];
  syncedBlock: number | null;
}

export async function getV4UserRiskTrajectory(
  args: UserRiskTrajectoryArgs
): Promise<UserRiskTrajectoryResult> {
  const limit = Math.min(args.limit ?? 50, 500);
  const user = args.userAddress.toLowerCase();
  const query = `query Q($user: Bytes!, $limit: Int!) {
    _meta { block { number } }
    user(id: $user) {
      latestRiskPremium
      latestRiskPremiumSpoke { id }
      riskPremiumHistory(first: $limit, orderBy: block, orderDirection: desc) {
        riskPremium spoke { id } block timestamp txHash
      }
    }
  }`;
  const data = (await queryChain(DEPLOYMENT_ID, query, { user, limit })) as MetaBlock & {
    user?: {
      latestRiskPremium: string;
      latestRiskPremiumSpoke: { id: string } | null;
      riskPremiumHistory: Array<{
        riskPremium: string;
        spoke: { id: string };
        block: string;
        timestamp: string;
        txHash: string;
      }>;
    } | null;
  };
  const u = data.user;
  return {
    user,
    latestRiskPremium: u?.latestRiskPremium ?? null,
    latestRiskPremiumSpoke: u?.latestRiskPremiumSpoke?.id ?? null,
    history: (u?.riskPremiumHistory ?? []).map((s) => ({
      riskPremium: s.riskPremium,
      spoke: s.spoke.id,
      block: parseInt(s.block, 10),
      timestamp: parseInt(s.timestamp, 10),
      txHash: s.txHash,
    })),
    syncedBlock: data._meta?.block?.number ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2. Liquidation post-mortem (by tx hash OR by user)
// ---------------------------------------------------------------------------

export interface LiquidationPostmortemArgs {
  txHash?: string;
  userAddress?: string;
  limit?: number;
}

export interface LiquidationRecord {
  txHash: string;
  block: number;
  timestamp: number;
  spoke: string;
  collateralReserve: string;
  debtReserve: string;
  user: string;
  liquidator: string;
  receiveShares: boolean;
  debtAmountRestored: string;
  drawnSharesLiquidated: string;
  collateralAmountRemoved: string;
  collateralSharesLiquidated: string;
  collateralSharesToLiquidator: string;
  premiumSharesDelta: string;
  premiumOffsetRayDelta: string;
  restoredPremiumRay: string;
}

export interface LiquidationPostmortemResult {
  liquidations: LiquidationRecord[];
  syncedBlock: number | null;
  filterApplied: LiquidationPostmortemArgs;
}

export async function getV4LiquidationPostmortem(
  args: LiquidationPostmortemArgs
): Promise<LiquidationPostmortemResult> {
  if (!args.txHash && !args.userAddress) {
    throw new Error("Provide either txHash or userAddress.");
  }
  const limit = Math.min(args.limit ?? 25, 200);
  const whereParts: string[] = [];
  if (args.txHash) whereParts.push(`txHash: "${args.txHash.toLowerCase()}"`);
  if (args.userAddress) whereParts.push(`user: "${args.userAddress.toLowerCase()}"`);
  const where = whereParts.length ? `, where: { ${whereParts.join(", ")} }` : "";

  const query = `{
    _meta { block { number } }
    liquidationCalls(first: ${limit}, orderBy: block, orderDirection: desc${where}) {
      txHash block timestamp
      spoke { id } collateralReserve { id } debtReserve { id }
      user { id } liquidator receiveShares
      debtAmountRestored drawnSharesLiquidated
      collateralAmountRemoved collateralSharesLiquidated collateralSharesToLiquidator
      premiumSharesDelta premiumOffsetRayDelta restoredPremiumRay
    }
  }`;
  const data = (await queryChain(DEPLOYMENT_ID, query)) as MetaBlock & {
    liquidationCalls: Array<{
      txHash: string; block: string; timestamp: string;
      spoke: { id: string }; collateralReserve: { id: string }; debtReserve: { id: string };
      user: { id: string }; liquidator: string; receiveShares: boolean;
      debtAmountRestored: string; drawnSharesLiquidated: string;
      collateralAmountRemoved: string; collateralSharesLiquidated: string;
      collateralSharesToLiquidator: string;
      premiumSharesDelta: string; premiumOffsetRayDelta: string; restoredPremiumRay: string;
    }>;
  };
  return {
    liquidations: (data.liquidationCalls ?? []).map((l) => ({
      txHash: l.txHash, block: parseInt(l.block, 10), timestamp: parseInt(l.timestamp, 10),
      spoke: l.spoke.id, collateralReserve: l.collateralReserve.id, debtReserve: l.debtReserve.id,
      user: l.user.id, liquidator: l.liquidator, receiveShares: l.receiveShares,
      debtAmountRestored: l.debtAmountRestored,
      drawnSharesLiquidated: l.drawnSharesLiquidated,
      collateralAmountRemoved: l.collateralAmountRemoved,
      collateralSharesLiquidated: l.collateralSharesLiquidated,
      collateralSharesToLiquidator: l.collateralSharesToLiquidator,
      premiumSharesDelta: l.premiumSharesDelta,
      premiumOffsetRayDelta: l.premiumOffsetRayDelta,
      restoredPremiumRay: l.restoredPremiumRay,
    })),
    syncedBlock: data._meta?.block?.number ?? null,
    filterApplied: args,
  };
}

// ---------------------------------------------------------------------------
// 3. Treasury flows (FeeMint, Sweep, Reclaim, DeficitEliminated)
// ---------------------------------------------------------------------------

export interface TreasuryFlowsArgs {
  hubName?: "Core" | "Plus" | "Prime";
  sinceMinutes?: number;
  limit?: number;
}

export interface FeeMintRow {
  type: "FEE_MINT";
  txHash: string; block: number; timestamp: number;
  hubAsset: string; feeReceiver: string;
  shares: string; assets: string;
}
export interface SweepRow {
  type: "SWEEP";
  txHash: string; block: number; timestamp: number;
  hubAsset: string; reinvestmentController: string; amount: string;
}
export interface ReclaimRow {
  type: "RECLAIM";
  txHash: string; block: number; timestamp: number;
  hubAsset: string; reinvestmentController: string; amount: string;
}
export interface DeficitEliminatedRow {
  type: "DEFICIT_ELIMINATED";
  txHash: string; block: number; timestamp: number;
  hubAsset: string; callerSpoke: string; coveredSpoke: string;
  shares: string; deficitAmountRay: string;
}

export type TreasuryRow = FeeMintRow | SweepRow | ReclaimRow | DeficitEliminatedRow;

export interface TreasuryFlowsResult {
  rows: TreasuryRow[];
  syncedBlock: number | null;
  filterApplied: TreasuryFlowsArgs;
}

export async function getV4TreasuryFlows(
  args: TreasuryFlowsArgs
): Promise<TreasuryFlowsResult> {
  const limit = Math.min(args.limit ?? 25, 200);
  const filters: string[] = [];
  if (args.hubName) {
    const addr = HUB_ADDRESS[args.hubName];
    if (addr) filters.push(`hub: "${addr}"`);
  }
  if (args.sinceMinutes && args.sinceMinutes > 0) {
    const since = Math.floor(Date.now() / 1000) - args.sinceMinutes * 60;
    filters.push(`timestamp_gte: "${since}"`);
  }
  const where = filters.length ? `, where: { ${filters.join(", ")} }` : "";

  const query = `{
    _meta { block { number } }
    feeMints(first: ${limit}, orderBy: block, orderDirection: desc${where}) {
      txHash block timestamp feeReceiver shares assets
      hubAsset { id }
    }
    sweeps(first: ${limit}, orderBy: block, orderDirection: desc${where}) {
      txHash block timestamp reinvestmentController amount
      hubAsset { id }
    }
    reclaims(first: ${limit}, orderBy: block, orderDirection: desc${where}) {
      txHash block timestamp reinvestmentController amount
      hubAsset { id }
    }
    deficitEliminateds(first: ${limit}, orderBy: block, orderDirection: desc${where}) {
      txHash block timestamp shares deficitAmountRay
      hubAsset { id } callerSpoke { id } coveredSpoke { id }
    }
  }`;

  const data = (await queryChain(DEPLOYMENT_ID, query)) as MetaBlock & {
    feeMints: Array<{ txHash: string; block: string; timestamp: string; feeReceiver: string; shares: string; assets: string; hubAsset: { id: string } }>;
    sweeps: Array<{ txHash: string; block: string; timestamp: string; reinvestmentController: string; amount: string; hubAsset: { id: string } }>;
    reclaims: Array<{ txHash: string; block: string; timestamp: string; reinvestmentController: string; amount: string; hubAsset: { id: string } }>;
    deficitEliminateds: Array<{ txHash: string; block: string; timestamp: string; shares: string; deficitAmountRay: string; hubAsset: { id: string }; callerSpoke: { id: string }; coveredSpoke: { id: string } }>;
  };

  const rows: TreasuryRow[] = [];
  for (const r of data.feeMints ?? []) {
    rows.push({
      type: "FEE_MINT", txHash: r.txHash, block: parseInt(r.block, 10),
      timestamp: parseInt(r.timestamp, 10), hubAsset: r.hubAsset.id,
      feeReceiver: r.feeReceiver, shares: r.shares, assets: r.assets,
    });
  }
  for (const r of data.sweeps ?? []) {
    rows.push({
      type: "SWEEP", txHash: r.txHash, block: parseInt(r.block, 10),
      timestamp: parseInt(r.timestamp, 10), hubAsset: r.hubAsset.id,
      reinvestmentController: r.reinvestmentController, amount: r.amount,
    });
  }
  for (const r of data.reclaims ?? []) {
    rows.push({
      type: "RECLAIM", txHash: r.txHash, block: parseInt(r.block, 10),
      timestamp: parseInt(r.timestamp, 10), hubAsset: r.hubAsset.id,
      reinvestmentController: r.reinvestmentController, amount: r.amount,
    });
  }
  for (const r of data.deficitEliminateds ?? []) {
    rows.push({
      type: "DEFICIT_ELIMINATED", txHash: r.txHash, block: parseInt(r.block, 10),
      timestamp: parseInt(r.timestamp, 10), hubAsset: r.hubAsset.id,
      callerSpoke: r.callerSpoke.id, coveredSpoke: r.coveredSpoke.id,
      shares: r.shares, deficitAmountRay: r.deficitAmountRay,
    });
  }
  // Sort merged rows by block desc so the cap is global, not per-type
  rows.sort((a, b) => b.block - a.block);
  return { rows: rows.slice(0, limit), syncedBlock: data._meta?.block?.number ?? null, filterApplied: args };
}

// ---------------------------------------------------------------------------
// 4. Spoke config history (liquidation parameters governance trail)
// ---------------------------------------------------------------------------

export interface SpokeConfigHistoryArgs {
  spokeAddress: string;
  limit?: number;
}

export interface SpokeConfigSnapshot {
  targetHealthFactor: string;
  healthFactorForMaxBonus: string;
  liquidationBonusFactor: number;
  block: number;
  timestamp: number;
  txHash: string;
}

export interface SpokeConfigHistoryResult {
  spoke: string;
  current: SpokeConfigSnapshot | null;
  history: SpokeConfigSnapshot[];
  syncedBlock: number | null;
}

export async function getV4SpokeConfigHistory(
  args: SpokeConfigHistoryArgs
): Promise<SpokeConfigHistoryResult> {
  const limit = Math.min(args.limit ?? 50, 500);
  const spoke = args.spokeAddress.toLowerCase();
  const query = `query Q($spoke: Bytes!, $limit: Int!) {
    _meta { block { number } }
    spokeLiquidationConfig(id: $spoke) {
      targetHealthFactor healthFactorForMaxBonus liquidationBonusFactor
      updatedAtBlock updatedAtTx
      history(first: $limit, orderBy: block, orderDirection: desc) {
        targetHealthFactor healthFactorForMaxBonus liquidationBonusFactor
        block timestamp txHash
      }
    }
  }`;
  const data = (await queryChain(DEPLOYMENT_ID, query, { spoke, limit })) as MetaBlock & {
    spokeLiquidationConfig?: {
      targetHealthFactor: string; healthFactorForMaxBonus: string;
      liquidationBonusFactor: number; updatedAtBlock: string; updatedAtTx: string;
      history: Array<{
        targetHealthFactor: string; healthFactorForMaxBonus: string;
        liquidationBonusFactor: number;
        block: string; timestamp: string; txHash: string;
      }>;
    } | null;
  };
  const cfg = data.spokeLiquidationConfig;
  const current: SpokeConfigSnapshot | null = cfg
    ? {
        targetHealthFactor: cfg.targetHealthFactor,
        healthFactorForMaxBonus: cfg.healthFactorForMaxBonus,
        liquidationBonusFactor: cfg.liquidationBonusFactor,
        block: parseInt(cfg.updatedAtBlock, 10),
        timestamp: 0,
        txHash: cfg.updatedAtTx,
      }
    : null;
  return {
    spoke,
    current,
    history: (cfg?.history ?? []).map((h) => ({
      targetHealthFactor: h.targetHealthFactor,
      healthFactorForMaxBonus: h.healthFactorForMaxBonus,
      liquidationBonusFactor: h.liquidationBonusFactor,
      block: parseInt(h.block, 10),
      timestamp: parseInt(h.timestamp, 10),
      txHash: h.txHash,
    })),
    syncedBlock: data._meta?.block?.number ?? null,
  };
}
