/**
 * Per-chain viem RPC clients + Aave V3 view-contract addresses.
 *
 * Uses `@aave-dao/aave-address-book` as the source of truth for addresses,
 * so view contracts can't drift out of sync with on-chain deployments.
 *
 * RPC URL precedence: per-chain env var, then a list of public endpoints
 * tried in order (viem fallback, no racing). Set ETHEREUM_RPC_URL /
 * BASE_RPC_URL / ARBITRUM_RPC_URL / POLYGON_RPC_URL / OPTIMISM_RPC_URL /
 * AVALANCHE_RPC_URL for production reliability — public endpoints rate-limit.
 */

import {
  createPublicClient,
  fallback,
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

/** Public endpoints tried after the optional dedicated URL. Order is the try order. */
export const PUBLIC_FALLBACKS: Record<string, string[]> = {
  ethereum: [
    "https://ethereum.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
    "https://eth.llamarpc.com",
  ],
  base: [
    "https://base.publicnode.com",
    "https://mainnet.base.org",
  ],
  arbitrum: [
    "https://arbitrum.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ],
  polygon: [
    "https://polygon.publicnode.com",
    "https://polygon-rpc.com",
  ],
  optimism: [
    "https://optimism.publicnode.com",
    "https://mainnet.optimism.io",
  ],
  avalanche: [
    "https://avalanche.publicnode.com",
    "https://api.avax.network/ext/bc/C/rpc",
  ],
};

/** URLs rpcClient will try, dedicated env URL first. */
export function rpcUrlPlan(chainKey: string): string[] {
  const cfg = RPC_CHAINS[chainKey];
  if (!cfg) {
    throw new Error(
      `Unsupported RPC chain: ${chainKey}. Supported: ${RPC_CHAIN_NAMES.join(", ")}`
    );
  }
  const envUrl = process.env[cfg.rpcEnvVar];
  const publics = PUBLIC_FALLBACKS[chainKey] ?? [];
  const urls = envUrl ? [envUrl, ...publics.filter((url) => url !== envUrl)] : [...publics];
  return urls;
}

export function clearRpcClient(chainKey?: string): void {
  if (chainKey) delete _clientCache[chainKey];
  else for (const key of Object.keys(_clientCache)) delete _clientCache[key];
}

export function hasCachedRpcClient(chainKey: string): boolean {
  return _clientCache[chainKey] != null;
}

export function rpcBackoffMs(attempt: number): number {
  const base = Number(process.env.RPC_RETRY_BASE_MS ?? 300);
  const ms = Number.isFinite(base) && base >= 0 ? base : 300;
  return ms * 2 ** attempt;
}

export function isRetryableRpcError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|rate limit|timeout|ECONNRESET|503|fetch failed/i.test(msg);
}

/**
 * Retry a live read when the endpoint rate-limits or drops the connection.
 * A retryable failure drops the cached client so the next attempt builds a
 * fresh fallback chain.
 */
export async function withRpcRetry<T>(chainKey: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isRetryableRpcError(error) || i === attempts - 1) break;
      clearRpcClient(chainKey);
      await new Promise((resolve) => setTimeout(resolve, rpcBackoffMs(i)));
    }
  }
  throw last;
}

export function rpcClient(chainKey: string): PublicClient {
  if (_clientCache[chainKey]) return _clientCache[chainKey];
  const cfg = RPC_CHAINS[chainKey];
  if (!cfg) {
    throw new Error(
      `Unsupported RPC chain: ${chainKey}. Supported: ${RPC_CHAIN_NAMES.join(", ")}`
    );
  }
  const urls = rpcUrlPlan(chainKey);
  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for ${chainKey}. Set ${cfg.rpcEnvVar}.`);
  }
  const dedicated = Boolean(process.env[cfg.rpcEnvVar]);
  // Bound every hop. viem's defaults (10s x 3) let a rate-limited public
  // endpoint stall a tool call past 60s. The unconfigured path gets the
  // tighter budget because that is the one that rate-limits.
  const transports = urls.map((url) =>
    http(url, {
      timeout: dedicated ? 8_000 : 6_000,
      retryCount: 2,
      retryDelay: 400,
    })
  );
  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: fallback(transports, { rank: false }),
  }) as PublicClient;
  _clientCache[chainKey] = client;
  return client;
}

/** Appended to RPC failures so the caller knows the one-line fix. */
export function rpcHint(chainKey: string): string {
  const cfg = RPC_CHAINS[chainKey];
  return cfg
    ? ` Tried ${rpcUrlPlan(chainKey).length} RPC endpoint(s) with backoff. If this keeps failing, set ${cfg.rpcEnvVar} to a dedicated endpoint — public fallbacks are rate-limited.`
    : "";
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
