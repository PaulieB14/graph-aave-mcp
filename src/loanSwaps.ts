import { aaveV4Gql } from "./aaveV4Api.js";
import { queryChain, querySubgraphId } from "./graphClient.js";
import { V4_NETWORKS, type V4Network } from "./v4Subgraph.js";

/**
 * Loan swaps (borrow swaps) launched 2026-11-12 on Aave V4 Ethereum, Base,
 * and Avalanche via CoW Swap. The V4 API records them as BORROW_SWAP.
 * The V4 subgraphs have no swap entity: the same transaction is a REPAY
 * plus a BORROW for one user, routed through the CoW flash-loan router
 * and settlement contract.
 */
export const LOAN_SWAP_CHAIN_IDS = [1, 8453, 43114] as const;

export const COW_FLASH_LOAN_ROUTER = "0x9da8b48441583a2b93e2ef8213aad0ec0b392c69";
export const COW_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";

const COW = new Set([COW_FLASH_LOAN_ROUTER, COW_SETTLEMENT]);

const CHAIN_NAME: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  43114: "Avalanche",
};

export interface NormalizedLoanSwap {
  source: "aave-v4-api" | "subgraph-repay-borrow";
  chainId: number | null;
  chainName: string | null;
  user: string;
  txHash: string | null;
  timestamp: string | null;
  timestampMs: number | null;
  fromAsset: string | null;
  toAsset: string | null;
  fromAmount: string | null;
  toAmount: string | null;
  fromUsd: number | null;
  toUsd: number | null;
  status?: string | null;
  kind?: string | null;
  orderClass?: string | null;
  cowRouted?: boolean;
}

export interface SubgraphActivity {
  type: string;
  amount?: string | null;
  timestamp?: string | null;
  txHash?: string | null;
  caller?: string | null;
  user?: { id?: string | null } | string | null;
  reserve?: { assetId?: string | null; reserveId?: string | null; symbol?: string | null } | null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function symbolOf(node: any): string | null {
  return node?.token?.info?.symbol
    ?? node?.reserve?.asset?.underlying?.info?.symbol
    ?? node?.info?.symbol
    ?? null;
}

function amountOf(node: any): { amount: string | null; usd: number | null } {
  const amount = node?.amount?.amount?.value ?? node?.amount?.value ?? null;
  const usd = num(node?.amount?.exchange?.value ?? node?.exchange?.value);
  return { amount: amount == null ? null : String(amount), usd };
}

function msOf(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  if (/^\d+$/.test(timestamp)) {
    const n = Number(timestamp);
    return n > 1e12 ? n : n * 1000;
  }
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeBorrowSwapActivity(item: any): NormalizedLoanSwap {
  const sell = amountOf(item?.sell);
  const buy = amountOf(item?.buy);
  const timestamp = item?.timestamp == null ? null : String(item.timestamp);
  return {
    source: "aave-v4-api",
    chainId: item?.chain?.chainId == null ? null : Number(item.chain.chainId),
    chainName: item?.chain?.name ?? null,
    user: String(item?.user ?? ""),
    txHash: item?.txHash ?? null,
    timestamp,
    timestampMs: msOf(timestamp),
    fromAsset: symbolOf(item?.sell),
    toAsset: symbolOf(item?.buy),
    fromAmount: sell.amount,
    toAmount: buy.amount,
    fromUsd: sell.usd,
    toUsd: buy.usd,
    status: item?.status ?? null,
    kind: item?.kind ?? null,
    orderClass: item?.orderClass ?? null,
  };
}

function userOf(row: SubgraphActivity): string {
  if (!row.user) return "";
  if (typeof row.user === "string") return row.user.toLowerCase();
  return (row.user.id ?? "").toLowerCase();
}

function assetLabel(row: SubgraphActivity): string {
  return row.reserve?.symbol || (row.reserve?.assetId != null ? `asset:${row.reserve.assetId}` : "unknown");
}

/**
 * A loan swap on the subgraph is a REPAY and a BORROW for the same user
 * in the same transaction. Other same-tx pairs (a manual repay plus a
 * fresh borrow) are included and flagged when `caller` is not a CoW router.
 */
export function pairRepayBorrow(rows: SubgraphActivity[], chainId: number): NormalizedLoanSwap[] {
  const groups = new Map<string, SubgraphActivity[]>();
  for (const row of rows) {
    const type = String(row.type || "").toUpperCase();
    if (type !== "REPAY" && type !== "BORROW") continue;
    const tx = (row.txHash || "").toLowerCase();
    const user = userOf(row);
    if (!tx || !user) continue;
    const key = `${tx}|${user}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const swaps: NormalizedLoanSwap[] = [];
  for (const [key, list] of groups) {
    const repays = list.filter((row) => String(row.type).toUpperCase() === "REPAY");
    const borrows = list.filter((row) => String(row.type).toUpperCase() === "BORROW");
    if (repays.length === 0 || borrows.length === 0) continue;
    const [tx, user] = key.split("|");
    const callers = list.map((row) => (row.caller || "").toLowerCase()).filter(Boolean);
    const timestamp = repays[0]?.timestamp ?? borrows[0]?.timestamp ?? null;
    const ts = timestamp == null ? null : String(timestamp);
    swaps.push({
      source: "subgraph-repay-borrow",
      chainId,
      chainName: CHAIN_NAME[chainId] ?? null,
      user,
      txHash: tx,
      timestamp: ts,
      timestampMs: msOf(ts),
      fromAsset: uniqueLabels(repays),
      toAsset: uniqueLabels(borrows),
      fromAmount: sumRaw(repays),
      toAmount: sumRaw(borrows),
      fromUsd: null,
      toUsd: null,
      cowRouted: callers.some((caller) => COW.has(caller)),
    });
  }
  return swaps.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
}

function uniqueLabels(rows: SubgraphActivity[]): string {
  return [...new Set(rows.map(assetLabel))].join("+");
}

function sumRaw(rows: SubgraphActivity[]): string | null {
  if (rows.length === 1) return rows[0].amount == null ? null : String(rows[0].amount);
  try {
    return rows.reduce((sum, row) => sum + BigInt(row.amount || "0"), 0n).toString();
  } catch {
    return null;
  }
}

export function mergeLoanSwaps(apiRows: NormalizedLoanSwap[], subgraphRows: NormalizedLoanSwap[]): NormalizedLoanSwap[] {
  const seen = new Set(apiRows.map((row) => (row.txHash || "").toLowerCase()).filter(Boolean));
  const extra = subgraphRows.filter((row) => row.txHash && !seen.has(row.txHash.toLowerCase()));
  return [...apiRows, ...extra].sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
}

export function crossCheckLoanSwaps(apiRows: NormalizedLoanSwap[], subgraphRows: NormalizedLoanSwap[]) {
  const apiTx = new Set(apiRows.map((row) => (row.txHash || "").toLowerCase()).filter(Boolean));
  const subTx = new Set(subgraphRows.map((row) => (row.txHash || "").toLowerCase()).filter(Boolean));
  const matched = [...apiTx].filter((tx) => subTx.has(tx));
  return {
    apiCount: apiRows.length,
    subgraphPairCount: subgraphRows.length,
    matchedTxs: matched,
    apiOnlyTxs: [...apiTx].filter((tx) => !subTx.has(tx)),
    subgraphOnlyTxs: [...subTx].filter((tx) => !apiTx.has(tx)),
  };
}

export function aggregateLoanSwaps(
  swaps: NormalizedLoanSwap[],
  opts: { windowHours?: number; nowMs?: number } = {}
) {
  const now = opts.nowMs ?? Date.now();
  const windowMs = opts.windowHours != null ? opts.windowHours * 3600 * 1000 : null;
  const inWindow = windowMs == null
    ? swaps
    : swaps.filter((row) => row.timestampMs != null && now - row.timestampMs <= windowMs);
  const users = new Set<string>();
  const pairs = new Map<string, { from: string; to: string; count: number; volumeUsd: number }>();
  let volumeUsd = 0;
  let volumeSamples = 0;
  for (const swap of inWindow) {
    if (swap.user) users.add(swap.user.toLowerCase());
    const usd = swap.fromUsd ?? swap.toUsd;
    if (usd != null) {
      volumeUsd += usd;
      volumeSamples++;
    }
    const from = swap.fromAsset ?? "?";
    const to = swap.toAsset ?? "?";
    const key = `${from}→${to}`;
    const row = pairs.get(key) ?? { from, to, count: 0, volumeUsd: 0 };
    row.count += 1;
    if (usd != null) row.volumeUsd += usd;
    pairs.set(key, row);
  }
  const topPairs = [...pairs.values()].sort((a, b) => b.volumeUsd - a.volumeUsd || b.count - a.count);
  return {
    windowHours: opts.windowHours ?? null,
    count: inWindow.length,
    uniqueUsers: users.size,
    volumeUsd,
    volumeSamples,
    volumeNote: "volumeUsd sums the from-asset USD on API rows (the debt rotated out). Subgraph-only pairs have no USD.",
    topPairs,
  };
}

const BORROW_SWAP_FIELDS = `
  items {
    __typename
    ... on BorrowSwapActivity {
      id user timestamp txHash
      chain { name chainId }
      orderClass kind status
      sell {
        reserve { id asset { underlying { info { symbol } } } }
        amount { amount { value decimals } exchange(currency: USD) { value symbol } token { info { symbol } } }
      }
      buy {
        reserve { id asset { underlying { info { symbol } } } }
        amount { amount { value decimals } exchange(currency: USD) { value symbol } token { info { symbol } } }
      }
    }
  }
  pageInfo { next prev }
`;

export function loanSwapChainIds(chainId?: number): number[] {
  return chainId != null ? [chainId] : [...LOAN_SWAP_CHAIN_IDS];
}

async function fetchApiBorrowSwaps(opts: {
  chainIds: number[];
  user?: string;
  maxPages: number;
}): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const request: Record<string, unknown> = {
      query: { chainIds: opts.chainIds },
      types: ["BORROW_SWAP"],
      pageSize: "FIFTY",
    };
    if (opts.user) request.user = opts.user;
    if (cursor) request.cursor = cursor;
    const data = await aaveV4Gql<{ activities: { items: any[]; pageInfo?: { next?: string | null } } }>(
      `query ($request: ActivitiesRequest!) { activities(request: $request) { ${BORROW_SWAP_FIELDS} } }`,
      { request }
    );
    items.push(...(data.activities?.items ?? []));
    const next = data.activities?.pageInfo?.next;
    if (!next) break;
    cursor = next;
  }
  return items;
}

function networkForChain(chainId: number): V4Network | null {
  if (chainId === 1) return "ethereum";
  if (chainId === 8453) return "base";
  return null;
}

async function queryV4Network(network: V4Network, query: string, vars?: Record<string, unknown>) {
  const target = V4_NETWORKS[network];
  return target.kind === "subgraph"
    ? querySubgraphId(target.id, query, vars)
    : queryChain(target.id, query, vars);
}

function activityQuery(opts: { txs?: string[]; user?: string; since?: string; limit: number }) {
  const filters = ["type_in: [REPAY, BORROW]"];
  const decls = ["$limit: Int!"];
  const vars: Record<string, unknown> = { limit: opts.limit };
  if (opts.txs && opts.txs.length > 0) {
    filters.push("txHash_in: $txs");
    decls.push("$txs: [Bytes!]");
    vars.txs = opts.txs.map((tx) => tx.toLowerCase());
  }
  if (opts.user) {
    filters.push("user: $user");
    decls.push("$user: String!");
    vars.user = opts.user.toLowerCase();
  }
  if (opts.since) {
    filters.push("timestamp_gte: $since");
    decls.push("$since: BigInt!");
    vars.since = opts.since;
  }
  const query = `query Q(${decls.join(", ")}) {
    userActivities(first: $limit, orderBy: timestamp, orderDirection: desc, where: { ${filters.join(", ")} }) {
      type amount timestamp txHash caller
      user { id }
      reserve { assetId reserveId }
    }
  }`;
  return { query, vars };
}

async function fetchSubgraphPairs(opts: {
  chainIds: number[];
  user?: string;
  txsByChain: Map<number, string[]>;
  scanRecent: boolean;
  sinceSec?: string;
}): Promise<{ pairs: NormalizedLoanSwap[]; errors: string[] }> {
  const pairs: NormalizedLoanSwap[] = [];
  const errors: string[] = [];
  for (const chainId of opts.chainIds) {
    const network = networkForChain(chainId);
    if (!network) {
      errors.push(`chain ${chainId} has no V4 subgraph cross-check (API only)`);
      continue;
    }
    const chainTxs = opts.txsByChain.get(chainId) ?? [];
    if (!opts.scanRecent && chainTxs.length === 0) continue;
    try {
      const built = activityQuery({
        txs: chainTxs.length > 0 ? chainTxs.slice(0, 100) : undefined,
        user: opts.user,
        since: chainTxs.length > 0 ? undefined : opts.sinceSec,
        limit: 200,
      });
      const data = await queryV4Network(network, built.query, built.vars) as { userActivities?: SubgraphActivity[] };
      pairs.push(...pairRepayBorrow(data.userActivities ?? [], chainId));
    } catch (err) {
      errors.push(`${network}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { pairs, errors };
}

export async function loadLoanSwaps(opts: {
  chainId?: number;
  user?: string;
  windowHours?: number;
  limit?: number;
  maxPages?: number;
}): Promise<{
  chains: number[];
  swaps: NormalizedLoanSwap[];
  apiCount: number;
  crossCheck: ReturnType<typeof crossCheckLoanSwaps> & { errors: string[] };
}> {
  const chains = loanSwapChainIds(opts.chainId);
  const apiItems = await fetchApiBorrowSwaps({
    chainIds: chains,
    user: opts.user,
    maxPages: opts.maxPages ?? 3,
  });
  const apiSwaps = apiItems
    .filter((item) => item?.__typename === "BorrowSwapActivity" || item?.sell)
    .map(normalizeBorrowSwapActivity)
    .filter((row) => opts.chainId == null || row.chainId === opts.chainId);

  const sinceSec = opts.windowHours != null
    ? String(Math.floor(Date.now() / 1000 - opts.windowHours * 3600))
    : String(Math.floor(Date.now() / 1000 - 14 * 24 * 3600));
  const txsByChain = new Map<number, string[]>();
  for (const row of apiSwaps) {
    if (row.chainId == null || !row.txHash) continue;
    const list = txsByChain.get(row.chainId) ?? [];
    list.push(row.txHash);
    txsByChain.set(row.chainId, list);
  }
  const subgraph = await fetchSubgraphPairs({
    chainIds: chains.filter((id) => id === 1 || id === 8453),
    user: opts.user,
    txsByChain,
    scanRecent: apiSwaps.length === 0,
    sinceSec,
  });
  if (chains.includes(43114)) {
    subgraph.errors.push("chain 43114 (Avalanche) has no V4 subgraph cross-check; those swaps come from the API only");
  }
  let swaps = mergeLoanSwaps(apiSwaps, subgraph.pairs);
  if (opts.windowHours != null) {
    const now = Date.now();
    const windowMs = opts.windowHours * 3600 * 1000;
    swaps = swaps.filter((row) => row.timestampMs != null && now - row.timestampMs <= windowMs);
  }
  if (opts.limit != null) swaps = swaps.slice(0, opts.limit);
  return {
    chains,
    swaps,
    apiCount: apiSwaps.length,
    crossCheck: { ...crossCheckLoanSwaps(apiSwaps, subgraph.pairs), errors: subgraph.errors },
  };
}
