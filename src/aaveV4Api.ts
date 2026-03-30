// Aave V4 API client — lightweight wrapper around the AaveKit GraphQL API
// V4 uses Aave's own hosted API (not The Graph subgraphs).
// When V4 subgraphs become available on The Graph, these queries can be
// migrated to subgraphs by adding entries to subgraphs.ts.

const AAVE_API = process.env.AAVE_V4_API_URL || "https://api.aave.com/graphql";

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
    const timeout = setTimeout(() => controller.abort(), 10000);
    response = await fetch(AAVE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    throw new AaveV4ApiError(
      "Aave V4 API at api.aave.com is not reachable. For current Aave data, use V2/V3 subgraph tools.",
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
// Hubs
// ---------------------------------------------------------------------------
export async function getV4Hubs(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{ hubs(request: { query: { ${filter} } }) {
    name chain { name chainId }
    summary { totalSupplied { current { value symbol } } totalBorrowed { current { value symbol } } utilizationRate { value } }
  } }`);
}

// ---------------------------------------------------------------------------
// Spokes
// ---------------------------------------------------------------------------
export async function getV4Spokes(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{ spokes(request: { query: { ${filter} } }) { name address chain { name chainId } } }`);
}

// ---------------------------------------------------------------------------
// Reserves
// ---------------------------------------------------------------------------
export async function getV4Reserves(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{ reserves(request: { query: { ${filter} } }) {
    asset { underlying { address chain { name chainId } info { name symbol decimals } } }
    spoke { name } chain { name chainId }
    summary { supplied { amount { value } } borrowed { amount { value } } supplyApy { value } borrowApy { value } }
    settings { collateralFactor { value } borrowCap { amount { value } } supplyCap { amount { value } } }
    status { frozen paused active } canBorrow canSupply canUseAsCollateral
  } }`);
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------
export async function getV4Chains(): Promise<unknown> {
  return gql(`{ chains(request: { query: { filter: ALL } }) { chainId name isTestnet } }`);
}

// ---------------------------------------------------------------------------
// Exchange Rate
// ---------------------------------------------------------------------------
export async function getV4ExchangeRate(
  from: { type: "erc20"; chainId: number; address: string } | { type: "native"; chainId: number } | { type: "fiat"; currency: string },
  to: string = "USD"
): Promise<unknown> {
  let fromVar: Record<string, unknown>;
  if (from.type === "erc20") fromVar = { erc20: { chainId: from.chainId, address: from.address } };
  else if (from.type === "native") fromVar = { native: from.chainId };
  else fromVar = { fiat: from.currency };
  return gql(`query ($request: ExchangeRateRequest!) { exchangeRate(request: $request) { value name symbol } }`,
    { request: { from: fromVar, to } });
}

// ---------------------------------------------------------------------------
// Asset detail + history
// ---------------------------------------------------------------------------
export async function getV4Asset(tokenAddress: string, chainId: number = 1): Promise<unknown> {
  return gql(`query ($request: AssetRequest!, $currency: Currency!, $timeWindow: TimeWindow!) {
    asset(request: $request) {
      id token { symbol name address chainId }
      summary {
        totalSupplied { amount { current { value } } exchange { current { value symbol } } }
        totalBorrowed { amount { current { value } } exchange { current { value symbol } } }
        averageSupplyApy: supplyApy(metric: AVERAGE) { value }
        averageBorrowApy: borrowApy(metric: AVERAGE) { value }
      }
      price(currency: $currency) { current { value symbol } }
    }
  }`, { request: { query: { token: { address: tokenAddress, chainId } } }, currency: "USD", timeWindow: "LAST_WEEK" });
}

export async function getV4AssetPriceHistory(tokenAddress: string, chainId: number = 1, window: string = "LAST_WEEK"): Promise<unknown> {
  return gql(`query ($request: AssetPriceHistoryRequest!) { assetPriceHistory(request: $request) { date price } }`,
    { request: { query: { token: { address: tokenAddress, chainId } }, currency: "USD", window } });
}

export async function getV4ProtocolHistory(window: string = "LAST_WEEK"): Promise<unknown> {
  return gql(`query ($request: ProtocolHistoryRequest!) { protocolHistory(request: $request) { date deposits { value symbol } borrows { value symbol } } }`,
    { request: { currency: "USD", window } });
}

// ---------------------------------------------------------------------------
// User positions
// ---------------------------------------------------------------------------
export async function getV4UserPositions(user: string): Promise<unknown> {
  return gql(`query ($request: UserPositionsRequest!, $currency: Currency!) {
    userPositions(request: $request, currency: $currency) {
      spoke { name chain { name chainId } }
      healthFactor { value }
      totalCollateral { current { value symbol } }
      totalDebt { current { value symbol } }
      netBalance { current { value symbol } }
      remainingBorrowingPower { value symbol }
      netApy { value }
    }
  }`, { request: { user }, currency: "USD" });
}

export async function getV4UserSummary(user: string): Promise<unknown> {
  return gql(`query ($request: UserSummaryRequest!, $currency: Currency!) {
    userSummary(request: $request, currency: $currency) {
      totalPositions netBalance { value symbol } totalCollateral { value symbol }
      totalSupplied { value symbol } totalDebt { value symbol } netApy { value }
      lowestHealthFactor
    }
  }`, { request: { user }, currency: "USD" });
}

export async function getV4UserSupplies(user: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user };
  if (chainId) request.chains = { chainIds: [chainId] };
  return gql(`query ($request: UserSuppliesRequest!, $currency: Currency!) {
    userSupplies(request: $request, currency: $currency) {
      reserve { asset { underlying { info { symbol name } } } chain { name } spoke { name } }
      principal { amount { value } } interest { amount { value } } isCollateral
    }
  }`, { request, currency: "USD" });
}

export async function getV4UserBorrows(user: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user };
  if (chainId) request.chains = { chainIds: [chainId] };
  return gql(`query ($request: UserBorrowsRequest!, $currency: Currency!) {
    userBorrows(request: $request, currency: $currency) {
      reserve { asset { underlying { info { symbol name } } } chain { name } spoke { name } }
      principal { amount { value } } debt { amount { value } } interest { amount { value } }
    }
  }`, { request, currency: "USD" });
}

// ---------------------------------------------------------------------------
// User balances (cross-chain token holdings)
// ---------------------------------------------------------------------------
export async function getV4UserBalances(user: string): Promise<unknown> {
  return gql(`query ($request: UserBalancesRequest!) {
    userBalances(request: $request) {
      info { __typename ... on Erc20Token { address info { symbol name } chain { name } } }
      totalAmount { value symbol }
      highestSupplyApy { value } lowestBorrowApy { value }
    }
  }`, { request: { user } });
}

// ---------------------------------------------------------------------------
// User activities (transaction history)
// ---------------------------------------------------------------------------
export async function getV4UserActivities(user: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user };
  if (chainId) request.chains = { chainIds: [chainId] };
  return gql(`query ($request: ActivitiesRequest!) {
    activities(request: $request) {
      items { __typename
        ... on SupplyActivity { timestamp txHash chain { name } reserve { asset { underlying { info { symbol } } } spoke { name } } amount { amount { value } } }
        ... on BorrowActivity { timestamp txHash chain { name } reserve { asset { underlying { info { symbol } } } spoke { name } } amount { amount { value } } }
        ... on WithdrawActivity { timestamp txHash chain { name } reserve { asset { underlying { info { symbol } } } spoke { name } } amount { amount { value } } }
        ... on RepayActivity { timestamp txHash chain { name } reserve { asset { underlying { info { symbol } } } spoke { name } } amount { amount { value } } }
        ... on LiquidatedActivity { timestamp txHash chain { name } }
        ... on TokenSwapActivity { timestamp txHash chain { name } }
      }
      pageInfo { next prev }
    }
  }`, { request });
}

// ---------------------------------------------------------------------------
// Claimable rewards
// ---------------------------------------------------------------------------
export async function getV4ClaimableRewards(user: string, chainId: number = 1): Promise<unknown> {
  return gql(`query ($request: UserClaimableRewardsRequest!) {
    userClaimableRewards(request: $request) {
      __typename
      ... on UserMerklClaimableReward { id startDate endDate claimUntil claimable { amount { value } token { info { symbol } } } }
    }
  }`, { request: { user, chainId } });
}

// ---------------------------------------------------------------------------
// Swap quote (read-only pricing)
// ---------------------------------------------------------------------------
export async function getV4SwapQuote(
  sellToken: { chainId: number; address: string },
  buyToken: { chainId: number; address: string },
  sellAmount: string,
  user: string
): Promise<unknown> {
  return gql(`query ($request: TokenSwapQuoteRequest!) {
    tokenSwapQuote(request: $request) {
      __typename
      ... on SwapByIntent { quote { quoteId suggestedSlippage { value } } }
      ... on SwapByIntentWithApprovalRequired { quote { quoteId suggestedSlippage { value } } }
      ... on SwapByTransaction { quote { quoteId } }
    }
  }`, {
    request: {
      market: {
        sell: { erc20: sellToken },
        buy: { erc20: buyToken },
        amount: { sell: { exact: sellAmount } },
        user,
      },
    },
  });
}
