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
    const timeout = setTimeout(() => controller.abort(), 8000);
    response = await fetch(AAVE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    throw new AaveV4ApiError(
      "Aave V4 API at api.aave.com is not reachable. " +
      "For current Aave data, use the V2/V3 subgraph tools (get_aave_reserves, get_aave_user_position, etc.).",
      undefined,
      AAVE_API
    );
  }

  if (!response.ok) {
    throw new AaveV4ApiError(
      `Aave V4 API returned HTTP ${response.status}: ${response.statusText}`,
      response.status,
      AAVE_API
    );
  }

  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new AaveV4ApiError(
      `Aave V4 GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
      undefined,
      AAVE_API
    );
  }
  if (!json.data) {
    throw new AaveV4ApiError("Aave V4 API returned no data", undefined, AAVE_API);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Hubs — V4 liquidity hubs (Core, Plus, Prime)
// ---------------------------------------------------------------------------

export async function getV4Hubs(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    hubs(request: { query: { ${filter} } }) {
      name
      chain { name chainId }
    }
  }`);
}

// ---------------------------------------------------------------------------
// Spokes — V4 cross-chain spokes (Kelp, Lido, Main, Bluechip, etc.)
// ---------------------------------------------------------------------------

export async function getV4Spokes(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    spokes(request: { query: { ${filter} } }) {
      name
      chain { name chainId }
    }
  }`);
}

// ---------------------------------------------------------------------------
// Reserves — V4 reserve data with APYs and risk params
// ---------------------------------------------------------------------------

export async function getV4Reserves(chainId?: number): Promise<unknown> {
  const filter = chainId ? `chainIds: [${chainId}]` : `chainIds: [1]`;
  return gql(`{
    reserves(request: { query: { ${filter} } }) {
      asset {
        underlying {
          address
          chain { name chainId }
          info { name symbol decimals }
        }
      }
      spoke { name }
      chain { name chainId }
      summary {
        supplyApy { value }
        borrowApy { value }
      }
      status { frozen paused active }
      canBorrow
      canSupply
      canUseAsCollateral
    }
  }`);
}

// ---------------------------------------------------------------------------
// User positions — V4 cross-chain positions
// ---------------------------------------------------------------------------

export async function getV4UserPositions(userAddress: string): Promise<unknown> {
  return gql(`
    query ($request: UserPositionsRequest!, $currency: Currency!) {
      userPositions(request: $request, currency: $currency) {
        spoke { name chain { name chainId } }
        healthFactor { value }
        totalCollateral { value }
        totalDebt { value }
        borrowingPower { value }
      }
    }
  `, { request: { user: userAddress }, currency: "USD" });
}

// ---------------------------------------------------------------------------
// User supplies — V4
// ---------------------------------------------------------------------------

export async function getV4UserSupplies(userAddress: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user: userAddress };
  if (chainId) request.chains = { chainIds: [chainId] };
  return gql(`
    query ($request: UserSuppliesRequest!, $currency: Currency!) {
      userSupplies(request: $request, currency: $currency) {
        reserve {
          asset { underlying { info { symbol name } } }
          chain { name }
          spoke { name }
        }
        isCollateral
      }
    }
  `, { request, currency: "USD" });
}

// ---------------------------------------------------------------------------
// User borrows — V4
// ---------------------------------------------------------------------------

export async function getV4UserBorrows(userAddress: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user: userAddress };
  if (chainId) request.chains = { chainIds: [chainId] };
  return gql(`
    query ($request: UserBorrowsRequest!, $currency: Currency!) {
      userBorrows(request: $request, currency: $currency) {
        reserve {
          asset { underlying { info { symbol name } } }
          chain { name }
          spoke { name }
        }
      }
    }
  `, { request, currency: "USD" });
}
