/**
 * Per-chain viem RPC clients + Aave V3 view-contract addresses.
 *
 * Uses `@aave-dao/aave-address-book` as the source of truth for addresses,
 * so view contracts can't drift out of sync with on-chain deployments.
 *
 * RPC URL precedence: per-chain env var → viem's bundled public RPC.
 * Set ETHEREUM_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL / POLYGON_RPC_URL /
 * OPTIMISM_RPC_URL / AVALANCHE_RPC_URL for production reliability.
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Chain,
} from "viem";
import {
  mainnet,
  base,
  arbitrum,
  polygon,
  optimism,
  avalanche,
} from "viem/chains";
import {
  AaveV3Ethereum,
  AaveV3Base,
  AaveV3Arbitrum,
  AaveV3Polygon,
  AaveV3Optimism,
  AaveV3Avalanche,
} from "@aave-dao/aave-address-book";

export interface RpcChainConfig {
  key: string;
  chainId: number;
  viemChain: Chain;
  rpcEnvVar: string;
  addresses: {
    POOL: `0x${string}`;
    POOL_ADDRESSES_PROVIDER: `0x${string}`;
    UI_POOL_DATA_PROVIDER: `0x${string}`;
    AAVE_PROTOCOL_DATA_PROVIDER: `0x${string}`;
    UI_INCENTIVE_DATA_PROVIDER: `0x${string}`;
    WALLET_BALANCE_PROVIDER: `0x${string}`;
  };
}

export const RPC_CHAINS: Record<string, RpcChainConfig> = {
  ethereum: {
    key: "ethereum",
    chainId: 1,
    viemChain: mainnet,
    rpcEnvVar: "ETHEREUM_RPC_URL",
    addresses: {
      POOL: AaveV3Ethereum.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Ethereum.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Ethereum.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Ethereum.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Ethereum.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Ethereum.WALLET_BALANCE_PROVIDER,
    },
  },
  base: {
    key: "base",
    chainId: 8453,
    viemChain: base,
    rpcEnvVar: "BASE_RPC_URL",
    addresses: {
      POOL: AaveV3Base.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Base.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Base.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Base.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Base.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Base.WALLET_BALANCE_PROVIDER,
    },
  },
  arbitrum: {
    key: "arbitrum",
    chainId: 42161,
    viemChain: arbitrum,
    rpcEnvVar: "ARBITRUM_RPC_URL",
    addresses: {
      POOL: AaveV3Arbitrum.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Arbitrum.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Arbitrum.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Arbitrum.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Arbitrum.WALLET_BALANCE_PROVIDER,
    },
  },
  polygon: {
    key: "polygon",
    chainId: 137,
    viemChain: polygon,
    rpcEnvVar: "POLYGON_RPC_URL",
    addresses: {
      POOL: AaveV3Polygon.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Polygon.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Polygon.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Polygon.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Polygon.WALLET_BALANCE_PROVIDER,
    },
  },
  optimism: {
    key: "optimism",
    chainId: 10,
    viemChain: optimism,
    rpcEnvVar: "OPTIMISM_RPC_URL",
    addresses: {
      POOL: AaveV3Optimism.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Optimism.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Optimism.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Optimism.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Optimism.WALLET_BALANCE_PROVIDER,
    },
  },
  avalanche: {
    key: "avalanche",
    chainId: 43114,
    viemChain: avalanche,
    rpcEnvVar: "AVALANCHE_RPC_URL",
    addresses: {
      POOL: AaveV3Avalanche.POOL,
      POOL_ADDRESSES_PROVIDER: AaveV3Avalanche.POOL_ADDRESSES_PROVIDER,
      UI_POOL_DATA_PROVIDER: AaveV3Avalanche.UI_POOL_DATA_PROVIDER,
      AAVE_PROTOCOL_DATA_PROVIDER: AaveV3Avalanche.AAVE_PROTOCOL_DATA_PROVIDER,
      UI_INCENTIVE_DATA_PROVIDER: AaveV3Avalanche.UI_INCENTIVE_DATA_PROVIDER,
      WALLET_BALANCE_PROVIDER: AaveV3Avalanche.WALLET_BALANCE_PROVIDER,
    },
  },
};

export const RPC_CHAIN_NAMES = Object.keys(RPC_CHAINS) as [
  string,
  ...string[],
];

const _clientCache: Record<string, PublicClient> = {};

export function rpcClient(chainKey: string): PublicClient {
  if (_clientCache[chainKey]) return _clientCache[chainKey];
  const cfg = RPC_CHAINS[chainKey];
  if (!cfg) {
    throw new Error(
      `Unsupported RPC chain: ${chainKey}. Supported: ${RPC_CHAIN_NAMES.join(", ")}`
    );
  }
  const rpcUrl = process.env[cfg.rpcEnvVar];
  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  }) as PublicClient;
  _clientCache[chainKey] = client;
  return client;
}

export function rpcAddresses(chainKey: string) {
  const cfg = RPC_CHAINS[chainKey];
  if (!cfg) {
    throw new Error(
      `Unsupported RPC chain: ${chainKey}. Supported: ${RPC_CHAIN_NAMES.join(", ")}`
    );
  }
  return cfg.addresses;
}

export function rpcChainId(chainKey: string): number {
  const cfg = RPC_CHAINS[chainKey];
  if (!cfg) {
    throw new Error(
      `Unsupported RPC chain: ${chainKey}. Supported: ${RPC_CHAIN_NAMES.join(", ")}`
    );
  }
  return cfg.chainId;
}
