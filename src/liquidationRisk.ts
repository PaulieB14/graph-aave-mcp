/**
 * Aave Liquidation Risk subgraph client — 5 chains
 *
 * Schema entities: Position, LiquidationCall, HealthFactorSnapshot, RiskAlert, ProtocolStats
 * Developer: 0x967c-20a189 — actively queried (~83K/month combined)
 */

import { queryChain } from "./graphClient.js";

// ── Subgraph IPFS hashes per chain ──────────────────────────────────────────
export const LIQUIDATION_RISK_CHAINS: Record<
  string,
  { name: string; chain: string; subgraphId: string; queries30d: number }
> = {
  "risk-ethereum": {
    name: "Aave Liquidation Risk — Ethereum",
    chain: "Ethereum",
    subgraphId: "QmUJCuxmCLCUbHW6oBX8BSKisnkokM41dLeuVD5ubo5CfF",
    queries30d: 21_100,
  },
  "risk-arbitrum": {
    name: "Aave Liquidation Risk — Arbitrum",
    chain: "Arbitrum",
    subgraphId: "QmSVwjmTndhr4f76P7W7aaqVpt9nVRs9ABtmpbZ72NSVoA",
    queries30d: 19_300,
  },
  "risk-base": {
    name: "Aave Liquidation Risk — Base",
    chain: "Base",
    subgraphId: "QmUWapvvoF83wkgkzsBFUm7fHqkEf3r2DkZj1x8fFdLyMx",
    queries30d: 16_200,
  },
  "risk-polygon": {
    name: "Aave Liquidation Risk — Polygon",
    chain: "Polygon",
    subgraphId: "QmdGnjVymZXfUxj2q4k874Vq17URRy1MQ7uQCc5gyKPDCK",
    queries30d: 13_200,
  },
  "risk-optimism": {
    name: "Aave Liquidation Risk — Optimism",
    chain: "Optimism",
    subgraphId: "QmNsrUebKCxDu8sSW1HdJSubqAazHDuHYHYEzZCb6zfNPE",
    queries30d: 13_000,
  },
};

export const RISK_CHAIN_NAMES = Object.keys(LIQUIDATION_RISK_CHAINS) as [
  string,
  ...string[],
];

// ── Query helpers ───────────────────────────────────────────────────────────

function riskSubgraphId(chain: string): string {
  const cfg = LIQUIDATION_RISK_CHAINS[chain];
  if (!cfg) throw new Error(`Unknown liquidation risk chain: ${chain}`);
  return cfg.subgraphId;
}

/** Positions at risk — filterable by riskLevel, ordered by riskScore desc */
export async function getAtRiskPositions(
  chain: string,
  riskLevel?: string,
  first = 25
): Promise<unknown> {
  const level = riskLevel?.toUpperCase();
  const where = level
    ? `where: { riskLevel: "${level}" }, `
    : `where: { riskLevel_not: "SAFE" }, `;
  const query = `{
    positions(${where}first: ${first}, orderBy: riskScore, orderDirection: desc) {
      id
      user
      reserve
      protocol
      network
      collateral
      debt
      healthFactor
      liquidationThreshold
      riskLevel
      riskScore
      lastUpdatedTimestamp
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Single user's positions across all reserves on a chain */
export async function getUserRiskPositions(
  chain: string,
  userAddress: string
): Promise<unknown> {
  const query = `{
    positions(where: { user: "${userAddress.toLowerCase()}" }, orderBy: riskScore, orderDirection: desc) {
      id
      user
      reserve
      protocol
      network
      collateral
      debt
      healthFactor
      liquidationThreshold
      riskLevel
      riskScore
      lastUpdatedTimestamp
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Protocol-wide risk stats (total/danger/warning/critical counts) */
export async function getProtocolRiskStats(chain: string): Promise<unknown> {
  const query = `{
    protocolStats_collection(first: 10) {
      id
      protocol
      network
      totalPositions
      dangerPositions
      warningPositions
      criticalPositions
      lastUpdated
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Recent risk alerts — health factor transitions */
export async function getRiskAlerts(
  chain: string,
  first = 25,
  userAddress?: string
): Promise<unknown> {
  const where = userAddress
    ? `where: { user: "${userAddress.toLowerCase()}" }, `
    : "";
  const query = `{
    riskAlerts(${where}first: ${first}, orderBy: timestamp, orderDirection: desc) {
      id
      user
      protocol
      network
      healthFactor
      riskLevel
      previousRiskLevel
      riskScore
      blockNumber
      timestamp
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Historical liquidation events from the risk subgraph */
export async function getRiskLiquidations(
  chain: string,
  first = 25,
  userAddress?: string
): Promise<unknown> {
  const where = userAddress
    ? `where: { user: "${userAddress.toLowerCase()}" }, `
    : "";
  const query = `{
    liquidationCalls(${where}first: ${first}, orderBy: timestamp, orderDirection: desc) {
      id
      user
      protocol
      network
      collateralAsset
      debtAsset
      debtToCover
      liquidatedCollateral
      liquidator
      blockNumber
      timestamp
      transactionHash
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Health factor history for a user */
export async function getHealthFactorHistory(
  chain: string,
  userAddress: string,
  first = 50
): Promise<unknown> {
  const query = `{
    healthFactorSnapshots(
      where: { user: "${userAddress.toLowerCase()}" },
      first: ${first},
      orderBy: timestamp,
      orderDirection: desc
    ) {
      id
      user
      protocol
      network
      healthFactor
      riskLevel
      riskScore
      blockNumber
      timestamp
    }
  }`;
  return queryChain(riskSubgraphId(chain), query);
}

/** Cross-chain risk summary — queries all 5 chains in parallel */
export async function getCrossChainRiskSummary(): Promise<unknown> {
  const results = await Promise.allSettled(
    RISK_CHAIN_NAMES.map(async (chain) => {
      const stats = (await getProtocolRiskStats(chain)) as {
        protocolStats_collection?: Array<{
          network: string;
          totalPositions: string;
          dangerPositions: string;
          warningPositions: string;
          criticalPositions: string;
        }>;
      };
      const cfg = LIQUIDATION_RISK_CHAINS[chain];
      return {
        chainKey: chain,
        name: cfg.name,
        network: cfg.chain,
        subgraphId: cfg.subgraphId,
        queries30d: cfg.queries30d,
        stats: stats?.protocolStats_collection ?? [],
      };
    })
  );
  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { chain: "unknown", error: (r as PromiseRejectedResult).reason?.message }
  );
}
