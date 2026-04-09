// Aave V4 API client — lightweight wrapper around the AaveKit GraphQL API
// V4 uses Aave's own hosted API (not The Graph subgraphs).
// Official endpoint per https://aave.com/docs/aave-v4/getting-started/graphql:
//   https://api.v4.aave.com/graphql
// (api.aave.com/graphql is an alias that returns the same v4 schema.)

const AAVE_API = process.env.AAVE_V4_API_URL || "https://api.v4.aave.com/graphql";

export class AaveV4ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = "AaveV4ApiError";
  }
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    response = await fetch(AAVE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    throw new AaveV4ApiError(
      `Aave V4 API at ${AAVE_API} is not reachable. For current Aave data, use V2/V3 subgraph tools.`,
      undefined, AAVE_API
    );
  }

  if (!response.ok) {
    throw new AaveV4ApiError(`Aave V4 API HTTP ${response.status}: ${response.statusText}`, response.status, AAVE_API);
  }

  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new AaveV4ApiError(`Aave V4 GraphQL: ${json.errors.map(e => e.message).join("; ")}`, undefined, AAVE_API);
  }
  if (!json.data) {
    throw new AaveV4ApiError("Aave V4 API returned no data", undefined, AAVE_API);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Reusable GraphQL fragments — match the AaveKit schema as of 2026-04
// ---------------------------------------------------------------------------
// Erc20Token has nested `info` (where name/symbol/decimals live) and `chain`
// (which holds chainId/name). NOT top-level symbol/name/chainId.
const TOKEN_FIELDS = `
  address
  isWrappedNativeToken
  chain { name chainId }
  info { name symbol decimals icon }
`;

// ExchangeAmountWithChange wraps an ExchangeAmount in `current` plus a `change`
// function field that requires a window argument — we just take `current` here.
// Plain ExchangeAmount has value/name/symbol directly.
const EXCHANGE_WITH_CHANGE = `current { value name symbol }`;
const EXCHANGE_FLAT = `value name symbol`;

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------
export async function getV4Hubs(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    hubs(request: { query: { ${filter} } }) {
      id name address
      chain { name chainId }
      summary {
        totalSupplied { ${EXCHANGE_WITH_CHANGE} }
        totalBorrowed { ${EXCHANGE_WITH_CHANGE} }
        utilizationRate { value normalized }
      }
    }
  }`);
}

// ---------------------------------------------------------------------------
// Spokes
// ---------------------------------------------------------------------------
export async function getV4Spokes(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    spokes(request: { query: { ${filter} } }) {
      id name address chain { name chainId }
    }
  }`);
}

// ---------------------------------------------------------------------------
// Reserves
// ---------------------------------------------------------------------------
export async function getV4Reserves(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    reserves(request: {
      query: { ${filter} },
      filter: ALL,
      orderBy: { supplyApy: DESC }
    }) {
      id
      asset {
        underlying { ${TOKEN_FIELDS} }
      }
      spoke { name address }
      chain { name chainId }
      summary {
        supplied { amount { value } exchange { ${EXCHANGE_FLAT} } }
        borrowed { amount { value } exchange { ${EXCHANGE_FLAT} } }
        supplyApy { value normalized }
        borrowApy { value normalized }
      }
      canBorrow canSupply canUseAsCollateral
    }
  }`);
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------
export async function getV4Chains(): Promise<unknown> {
  return gql(`{
    chains(request: { query: { filter: ALL } }) {
      chainId name icon isTestnet
    }
  }`);
}

// ---------------------------------------------------------------------------
// Exchange Rate
// ---------------------------------------------------------------------------
export async function getV4ExchangeRate(
  from:
    | { type: "erc20"; chainId: number; address: string }
    | { type: "native"; chainId: number }
    | { type: "fiat"; currency: string },
  to: string = "USD"
): Promise<unknown> {
  let fromVar: Record<string, unknown>;
  if (from.type === "erc20") fromVar = { erc20: { chainId: from.chainId, address: from.address } };
  else if (from.type === "native") fromVar = { native: from.chainId };
  else fromVar = { fiat: from.currency };
  return gql(
    `query ($request: ExchangeRateRequest!) {
      exchangeRate(request: $request) { value name symbol }
    }`,
    { request: { from: fromVar, to } }
  );
}

// ---------------------------------------------------------------------------
// Asset detail + history
// AssetSummary uses AssetAmountWithChange (which has nested amount + exchange,
// each with current/change). supplyApy/borrowApy are functions with default
// metric: AVERAGE — just request value/normalized.
// ---------------------------------------------------------------------------
export async function getV4Asset(tokenAddress: string, chainId: number = 1): Promise<unknown> {
  return gql(
    `query ($request: AssetRequest!) {
      asset(request: $request) {
        id
        token { ${TOKEN_FIELDS} }
        summary {
          totalSupplied {
            amount { current { value decimals } }
            exchange { current { ${EXCHANGE_FLAT} } }
          }
          totalBorrowed {
            amount { current { value decimals } }
            exchange { current { ${EXCHANGE_FLAT} } }
          }
          supplyApy { value normalized }
          borrowApy { value normalized }
        }
        price { ${EXCHANGE_WITH_CHANGE} }
      }
    }`,
    { request: { query: { token: { address: tokenAddress, chainId } } } }
  );
}

export async function getV4AssetPriceHistory(
  tokenAddress: string,
  chainId: number = 1,
  window: string = "LAST_WEEK"
): Promise<unknown> {
  return gql(
    `query ($request: AssetPriceHistoryRequest!) {
      assetPriceHistory(request: $request) { date price }
    }`,
    {
      request: {
        query: { token: { address: tokenAddress, chainId } },
        currency: "USD",
        window,
      },
    }
  );
}

export async function getV4ProtocolHistory(window: string = "LAST_WEEK"): Promise<unknown> {
  return gql(
    `query ($request: ProtocolHistoryRequest!) {
      protocolHistory(request: $request) {
        date
        deposits { value symbol }
        borrows { value symbol }
      }
    }`,
    { request: { currency: "USD", window } }
  );
}

// ---------------------------------------------------------------------------
// User positions — requires `filter` (mandatory) and `orderBy`
// ---------------------------------------------------------------------------
export async function getV4UserPositions(user: string, chainId?: number): Promise<unknown> {
  // UserPositionsRequestFilter is a oneof input — must have exactly ONE field.
  // Default to mainnet if not specified.
  const filter: Record<string, unknown> = { chainIds: [chainId || 1] };
  return gql(
    `query ($request: UserPositionsRequest!) {
      userPositions(request: $request) {
        id
        spoke { name chain { name chainId } }
        healthFactor { current }
        totalCollateral { ${EXCHANGE_WITH_CHANGE} }
        totalDebt { ${EXCHANGE_WITH_CHANGE} }
        netBalance { ${EXCHANGE_WITH_CHANGE} }
        remainingBorrowingPower { ${EXCHANGE_FLAT} }
        netApy { value normalized }
      }
    }`,
    {
      request: {
        user,
        filter,
        orderBy: { netCollateral: "DESC" },
      },
    }
  );
}

export async function getV4UserSummary(user: string, chainId?: number): Promise<unknown> {
  const filter = chainId ? { chainIds: [chainId] } : null;
  const request: Record<string, unknown> = { user };
  if (filter) request.filter = filter;
  return gql(
    `query ($request: UserSummaryRequest!) {
      userSummary(request: $request) {
        totalPositions
        netBalance { ${EXCHANGE_WITH_CHANGE} }
        totalCollateral { ${EXCHANGE_FLAT} }
        totalSupplied { ${EXCHANGE_FLAT} }
        totalDebt { ${EXCHANGE_FLAT} }
        netApy { value normalized }
        netAccruedInterest { ${EXCHANGE_FLAT} }
        lowestHealthFactor
      }
    }`,
    { request }
  );
}

// User supplies — schema requires `query` with one of:
// userChains | userHub | userSpoke | userToken | userPositionId
// UserSupplyItem fields: id, reserve, principal, balance, withdrawable,
//                       interest, isCollateral, createdAt
export async function getV4UserSupplies(user: string, chainId?: number): Promise<unknown> {
  const query: Record<string, unknown> = chainId
    ? { userChains: { user, chainIds: [chainId] } }
    : { userChains: { user, chainIds: [1] } };
  return gql(
    `query ($request: UserSuppliesRequest!) {
      userSupplies(request: $request) {
        id
        createdAt
        isCollateral
        reserve {
          id
          asset { underlying { ${TOKEN_FIELDS} } }
          chain { name chainId }
          spoke { name }
        }
        principal { amount { value } exchange { ${EXCHANGE_FLAT} } }
        balance { amount { value } exchange { ${EXCHANGE_FLAT} } }
        withdrawable { amount { value } exchange { ${EXCHANGE_FLAT} } }
        interest { amount { value } exchange { ${EXCHANGE_FLAT} } }
      }
    }`,
    {
      request: {
        query,
        orderBy: { amount: "DESC" },
        includeZeroBalances: false,
      },
    }
  );
}

// UserBorrowItem fields: id, reserve, principal, debt, interest, createdAt
export async function getV4UserBorrows(user: string, chainId?: number): Promise<unknown> {
  const query: Record<string, unknown> = chainId
    ? { userChains: { user, chainIds: [chainId] } }
    : { userChains: { user, chainIds: [1] } };
  return gql(
    `query ($request: UserBorrowsRequest!) {
      userBorrows(request: $request) {
        id
        createdAt
        reserve {
          id
          asset { underlying { ${TOKEN_FIELDS} } }
          chain { name chainId }
          spoke { name }
        }
        principal { amount { value } exchange { ${EXCHANGE_FLAT} } }
        debt { amount { value } exchange { ${EXCHANGE_FLAT} } }
        interest { amount { value } exchange { ${EXCHANGE_FLAT} } }
      }
    }`,
    {
      request: {
        query,
        orderBy: { amount: "DESC" },
        includeZeroBalances: false,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// User balances (cross-chain token holdings)
// UserBalance: id, info: TokenInfo, balances, totalAmount: DecimalNumber,
// exchange: ExchangeAmount, supplyApy/borrowApy/collateralFactor: PercentNumber
// ---------------------------------------------------------------------------
export async function getV4UserBalances(user: string, chainId?: number): Promise<unknown> {
  const filter: Record<string, unknown> = {
    chains: {
      chainIds: chainId ? [chainId] : [1],
      byReservesType: "ALL",
    },
  };
  return gql(
    `query ($request: UserBalancesRequest!) {
      userBalances(request: $request) {
        id
        info { name symbol decimals icon }
        totalAmount { value decimals }
        exchange { ${EXCHANGE_FLAT} }
        supplyApy { value normalized }
        borrowApy { value normalized }
        collateralFactor { value normalized }
      }
    }`,
    {
      request: {
        user,
        filter,
        orderBy: { balance: "DESC" },
        includeZeroBalances: false,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// User activities (transaction history)
// ---------------------------------------------------------------------------
export async function getV4UserActivities(user: string, chainId?: number): Promise<unknown> {
  const query: Record<string, unknown> = chainId
    ? { chainIds: [chainId] }
    : { chainIds: [1] };
  return gql(
    `query ($request: ActivitiesRequest!) {
      activities(request: $request) {
        items {
          __typename
          ... on SupplyActivity {
            id timestamp txHash
            chain { name chainId }
            spoke { name }
            supplied { amount { value } exchange { ${EXCHANGE_FLAT} } token { ${TOKEN_FIELDS} } }
          }
          ... on BorrowActivity {
            id timestamp txHash
            chain { name chainId }
            spoke { name }
            borrowed { amount { value } exchange { ${EXCHANGE_FLAT} } token { ${TOKEN_FIELDS} } }
          }
        }
        pageInfo { next prev }
      }
    }`,
    {
      request: {
        query,
        user,
        types: ["SUPPLY", "BORROW"],
        pageSize: "TEN",
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Claimable rewards
// ---------------------------------------------------------------------------
export async function getV4ClaimableRewards(user: string, chainId: number = 1): Promise<unknown> {
  return gql(
    `query ($request: UserClaimableRewardsRequest!) {
      userClaimableRewards(request: $request) {
        __typename
      }
    }`,
    { request: { user, chainId } }
  );
}

// ---------------------------------------------------------------------------
// Swap quote (read-only pricing)
// MarketOrderTokenSwapQuoteInput requires:
//   accuracy, chainId, buy (TokenInput), sell (TokenInput),
//   amount (BigDecimal as string), kind, user
// ---------------------------------------------------------------------------
export async function getV4SwapQuote(
  sellToken: { chainId: number; address: string },
  buyToken: { chainId: number; address: string },
  sellAmount: string,
  user: string
): Promise<unknown> {
  return gql(
    `query ($request: TokenSwapQuoteRequest!) {
      tokenSwapQuote(request: $request) {
        __typename
      }
    }`,
    {
      request: {
        market: {
          accuracy: "ACCURATE",
          chainId: sellToken.chainId,
          // TokenInput.erc20 is an EvmAddress (plain string), not a wrapper.
          // chainId lives at the top-level of MarketOrderTokenSwapQuoteInput.
          sell: { erc20: sellToken.address },
          buy: { erc20: buyToken.address },
          amount: sellAmount,
          kind: "SELL",
          user,
        },
      },
    }
  );
}
