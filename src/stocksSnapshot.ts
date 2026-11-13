import { aaveV4Gql } from "./aaveV4Api.js";
import { querySubgraphId } from "./graphClient.js";
import { attachSubgraphMeta } from "./reserveAnnotate.js";
import { group, type Account, type Params, type PositionLeg } from "./stocksGap.js";

const BASE_SUBGRAPH =
  process.env.AAVE_V4_BASE_SUBGRAPH_ID || "9x1tg7KX3RXspnK7R1mahAZsM5gTmFhLrmJSbkoBsDdq";

const HOLDER_PAGES = 2;

interface HolderRow {
  address: string;
  amount?: { exchange?: { value?: string } };
}

export interface EquityReserve {
  id: string;
  symbol: string;
  collateralFactor: number;
  maxLiquidationBonus: number;
  suppliedUsd: number;
  borrowedUsd: number;
  canUseAsCollateral: boolean;
  canBorrow: boolean;
}

export function legsFromHolders(input: {
  supplied: Array<{ symbol: string; holders: Array<{ address: string; usd: number }> }>;
  borrowed: Array<{ symbol: string; holders: Array<{ address: string; usd: number }> }>;
}): PositionLeg[] {
  const legs: PositionLeg[] = [];
  for (const book of input.supplied) {
    for (const holder of book.holders) {
      if (holder.usd > 0) legs.push({ user: holder.address, symbol: book.symbol, collateralUsd: holder.usd });
    }
  }
  for (const book of input.borrowed) {
    for (const holder of book.holders) {
      if (holder.usd > 0) legs.push({ user: holder.address, symbol: book.symbol, debtUsd: holder.usd });
    }
  }
  return legs;
}

async function holderPage(reserveId: string, filter: "SUPPLIED" | "BORROWED", cursor?: string) {
  const data = await aaveV4Gql<{
    reserveHolders: { items: HolderRow[]; pageInfo: { next?: string | null } };
  }>(
    `query ($request: PaginatedReserveHoldersRequest!) {
      reserveHolders(request: $request) {
        items { address amount { exchange(currency: USD) { value } } }
        pageInfo { next }
      }
    }`,
    {
      request: {
        reserve: { reserveId },
        filter,
        orderBy: { amount: "DESC" },
        pageSize: "FIFTY",
        ...(cursor ? { cursor } : {}),
      },
    }
  );
  return data.reserveHolders;
}

async function topHolders(reserveId: string, filter: "SUPPLIED" | "BORROWED") {
  const holders: Array<{ address: string; usd: number }> = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < HOLDER_PAGES; page++) {
    const result = await holderPage(reserveId, filter, cursor);
    for (const item of result.items ?? []) {
      const usd = Number(item.amount?.exchange?.value ?? 0);
      if (item.address && Number.isFinite(usd)) holders.push({ address: item.address, usd });
    }
    if (!result.pageInfo?.next) {
      truncated = false;
      break;
    }
    cursor = result.pageInfo.next;
    truncated = true;
  }
  return { holders, truncated };
}

/**
 * Base equities book.
 *
 * The Base V4 subgraph indexes events and config, not live per-user balances,
 * so positions and collateral factors come from the Aave V4 API (`reserveHolders`
 * + reserve settings). The subgraph still supplies `_meta` so the answer carries
 * a block clock. Requires GRAPH_API_KEY for that clock.
 */
export async function fetchBaseStocksSnapshot(): Promise<{
  accounts: Account[];
  params: Params;
  reserves: EquityReserve[];
  truncated: boolean;
  _freshness: unknown;
  sources: { positions: string; params: string; freshness: string };
  coverage: string;
}> {
  const [meta, listed] = await Promise.all([
    querySubgraphId(BASE_SUBGRAPH, `{ _meta { block { number timestamp } } }`),
    aaveV4Gql<{ reserves: Array<Record<string, any>> }>(`{
      reserves(request: { query: { chainIds: [8453] }, filter: ALL, orderBy: { supplyApy: DESC } }) {
        id
        canBorrow
        canUseAsCollateral
        asset { underlying { info { symbol } } }
        settings {
          collateralFactor { value }
          maxLiquidationBonus { value }
        }
        summary {
          supplied { exchange(currency: USD) { value } }
          borrowed { exchange(currency: USD) { value } }
        }
      }
    }`),
  ]);

  const reserves: EquityReserve[] = (listed.reserves ?? []).map((row) => ({
    id: String(row.id),
    symbol: String(row.asset?.underlying?.info?.symbol ?? "?"),
    collateralFactor: Number(row.settings?.collateralFactor?.value ?? 0),
    maxLiquidationBonus: Number(row.settings?.maxLiquidationBonus?.value ?? 0),
    suppliedUsd: Number(row.summary?.supplied?.exchange?.value ?? 0),
    borrowedUsd: Number(row.summary?.borrowed?.exchange?.value ?? 0),
    canUseAsCollateral: Boolean(row.canUseAsCollateral),
    canBorrow: Boolean(row.canBorrow),
  }));

  const params: Params = { collateralFactor: {}, maxLiquidationBonus: {} };
  for (const reserve of reserves) {
    params.collateralFactor[reserve.symbol] = reserve.collateralFactor;
    params.maxLiquidationBonus[reserve.symbol] = reserve.maxLiquidationBonus;
  }

  const collateral = reserves.filter((r) => r.canUseAsCollateral && r.collateralFactor > 0);
  const debt = reserves.filter((r) => r.canBorrow);
  let truncated = false;
  const supplied: Array<{ symbol: string; holders: Array<{ address: string; usd: number }> }> = [];
  const borrowed: Array<{ symbol: string; holders: Array<{ address: string; usd: number }> }> = [];

  for (const reserve of collateral) {
    const page = await topHolders(reserve.id, "SUPPLIED");
    truncated = truncated || page.truncated;
    supplied.push({ symbol: reserve.symbol, holders: page.holders });
  }
  for (const reserve of debt) {
    const page = await topHolders(reserve.id, "BORROWED");
    truncated = truncated || page.truncated;
    borrowed.push({ symbol: reserve.symbol, holders: page.holders });
  }

  const stamped = attachSubgraphMeta(meta) as { _freshness?: unknown };
  return {
    accounts: group(legsFromHolders({ supplied, borrowed })),
    params,
    reserves,
    truncated,
    _freshness: stamped._freshness ?? null,
    sources: {
      positions: "aave-v4-api reserveHolders",
      params: "aave-v4-api reserve settings",
      freshness: "base-v4-subgraph _meta",
    },
    coverage:
      "Top holders per reserve (50 per page, up to 2 pages), ordered by amount. " +
      "A wallet outside that page is omitted, so this is the large-book view, not every position.",
  };
}
