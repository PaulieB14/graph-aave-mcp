export interface ChainConfig {
  name: string;
  chain: string;
  version: string;
  subgraphId: string;
  queries30d: number;
  description: string;
  keyEntities: string[];
  isGovernance?: boolean;
}

// All deployment IDs sourced directly from The Graph — sorted by 30-day query volume.
// Using deployment IDs (IPFS hashes) for stable, pinned resolution.
// API endpoint format: https://gateway.thegraph.com/api/[api-key]/subgraphs/id/[deployment-id]
//
// Lending protocol schema (V3): reserves, userReserves, borrows, supplies, repays,
//   liquidationCalls, flashLoans, pool, protocol
// Lending protocol schema (V2): same but uses "deposit" instead of "supply"
// Rate fields (liquidityRate, variableBorrowRate): RAY units (1e27)
//   → APY % = rate / 1e27 * 100
// Amount fields: native token units → divide by 10^decimals for human-readable
//
// Governance schema (governance-v3): proposals, proposalVotes, payloads,
//   votingPortals, votingConfigs, proposalMetadata_collection
export const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    name: "AAVE Protocol V3 Ethereum",
    chain: "Ethereum",
    version: "v3",
    subgraphId: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
    queries30d: 21_600_000,
    description:
      "AAVE V3 on Ethereum mainnet — highest query volume (21.6M/30d). " +
      "The primary and most liquid AAVE deployment. Ideal for querying reserves, " +
      "user health factors, ETH/WBTC/stablecoin lending rates, and liquidation data.",
    keyEntities: [
      "reserve (symbol, totalLiquidity, availableLiquidity, liquidityRate, variableBorrowRate, baseLTVasCollateral, reserveLiquidationThreshold, price { priceInEth })",
      "userReserve (currentATokenBalance, currentVariableDebt, currentStableDebt, currentTotalDebt, usageAsCollateralEnabledOnUser)",
      "borrow (user, reserve, amount, borrowRate, borrowRateMode, txHash, timestamp)",
      "supply (user, reserve, amount, txHash, timestamp)",
      "repay (user, reserve, amount, txHash, timestamp)",
      "liquidationCall (collateralReserve, principalReserve, liquidator, user, collateralAmount, principalAmount)",
      "flashLoan (reserve, initiator, amount, totalFee, timestamp)",
    ],
  },
  base: {
    name: "Aave V3 Base",
    chain: "Base",
    version: "v3",
    subgraphId: "QmXZ53Kzz3L2LvvbGve2ebtLKWMhjjB1a3U2jnUj2YwGCW",
    queries30d: 5_618_153,
    description:
      "AAVE V3 on Base — 5.6M queries/30d. Fast-growing deployment on Coinbase's L2. " +
      "Good for cbETH, USDbC, and other Base-native asset lending rates.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  arbitrum: {
    name: "AAVE Protocol V3 Arbitrum",
    chain: "Arbitrum",
    version: "v3",
    subgraphId: "Qmdn5hAZZj3wmWVuksXHtua3E6aWftCDeTFcW8YQ8Lu6pB",
    queries30d: 5_600_000,
    description:
      "AAVE V3 on Arbitrum — 5.6M queries/30d. Major L2 deployment with deep ARB ecosystem liquidity.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  polygon: {
    name: "AAVE Protocol V3 Polygon",
    chain: "Polygon",
    version: "v3",
    subgraphId: "QmceoHP3ekxJ6JYqAXhqrVgv8rb9WXumrGe1ZhVZah8Ar5",
    queries30d: 2_000_000,
    description:
      "AAVE V3 on Polygon — 2M queries/30d. Established deployment with deep stablecoin liquidity.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  optimism: {
    name: "AAVE Protocol V3 Optimism",
    chain: "Optimism",
    version: "v3",
    subgraphId: "QmScPH3aFxzFgrie8MMDU4QtFu3CE7nTfsRfSQXiccxBPh",
    queries30d: 1_800_000,
    description:
      "AAVE V3 on Optimism — 1.8M queries/30d. OP ecosystem lending and borrowing.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  "ethereum-v2": {
    name: "AAVE Protocol V2 Ethereum",
    chain: "Ethereum",
    version: "v2",
    subgraphId: "QmdEuhCPTFx5q1Vf7jPQDVGQDpC34KYry82yb3NPc9sK6a",
    queries30d: 701_200,
    description:
      "AAVE V2 on Ethereum mainnet — legacy V2 deployment. " +
      "NOTE: uses 'deposit' entity instead of 'supply' for deposit events.",
    keyEntities: [
      "reserve / userReserve / borrow / deposit (NOT supply) / repay / liquidationCall / flashLoan",
    ],
  },
  avalanche: {
    name: "AAVE Protocol V3 Avalanche",
    chain: "Avalanche",
    version: "v3",
    subgraphId: "QmXhWmYZyEr8PGEic8F739wVqvMYxHLD7jke69RXmwQU95",
    queries30d: 1_200_000,
    description:
      "AAVE V3 on Avalanche — 1.2M queries/30d. AVAX ecosystem lending markets.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  "polygon-v2": {
    name: "Aave V2 Matic (Polygon)",
    chain: "Polygon",
    version: "v2",
    subgraphId: "QmNfojj4Wu1DErB9iC6epPZc4K2zQCrm4KJUra3DMQqSNm",
    queries30d: 215_830,
    description:
      "AAVE V2 on Polygon — 215K queries/30d. Legacy V2 deployment. " +
      "NOTE: uses 'deposit' entity instead of 'supply' for deposit events.",
    keyEntities: [
      "reserve / userReserve / borrow / deposit (NOT supply) / repay / liquidationCall / flashLoan",
    ],
  },
  "avalanche-v2": {
    name: "AAVE Protocol V2 Avalanche",
    chain: "Avalanche",
    version: "v2",
    subgraphId: "QmdDSA73QkFAvRZqtRoHgLvxonuSZTuJhoWkmBtEdVuTmz",
    queries30d: 133_000,
    description:
      "AAVE V2 on Avalanche — 133K queries/30d. Legacy V2 deployment. " +
      "NOTE: uses 'deposit' entity instead of 'supply'.",
    keyEntities: [
      "reserve / userReserve / borrow / deposit (NOT supply) / repay / liquidationCall / flashLoan",
    ],
  },
  fantom: {
    name: "AAVE Protocol V3 Fantom",
    chain: "Fantom",
    version: "v3",
    subgraphId: "QmNTzi2eFS2boHFFY372xrxGHNM8yPjF26H3eUxWTtnvoA",
    queries30d: 13_240,
    description:
      "AAVE V3 on Fantom — 13K queries/30d. Smaller Fantom deployment.",
    keyEntities: [
      "reserve / userReserve / borrow / supply / repay / liquidationCall / flashLoan",
    ],
  },
  governance: {
    name: "AAVE Governance V3 (Ethereum)",
    chain: "Ethereum",
    version: "governance-v3",
    subgraphId: "QmRyQo7xz4P3WvthdVzfkhwSzfwa8Uku1qrcyJCAN6RAWS",
    queries30d: 486_000,
    description:
      "AAVE Governance V3 on Ethereum — 486K queries/30d. Tracks all AAVE governance proposals, " +
      "voting activity, payloads, and voting portal configuration. " +
      "DIFFERENT SCHEMA from lending subgraphs — use get_governance_proposals and get_proposal_votes tools.",
    keyEntities: [
      "proposal (proposalId, creator, accessLevel, ipfsHash, state, votingDuration, votes { forVotes, againstVotes }, proposalMetadata { title })",
      "proposalVotes_collection (voter, votingPower, support, timestamp)",
      "payload (id, accessLevel, executionTime, transactions)",
      "votingPortal (chainId, votingStrategy, votingMachineAddress)",
      "votingConfig (accessLevel, cooldownBeforeVotingStart, votingDuration, quorum)",
      "proposalMetadata_collection (proposalId, title, rawContent)",
    ],
    isGovernance: true,
  },
};

export const CHAIN_NAMES = Object.keys(CHAINS) as [string, ...string[]];
export const LENDING_CHAIN_NAMES = Object.keys(CHAINS).filter(
  (k) => !CHAINS[k].isGovernance
) as [string, ...string[]];
