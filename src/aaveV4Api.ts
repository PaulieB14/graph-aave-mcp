// Aave V4 API client — lightweight wrapper around the AaveKit GraphQL API
// Complements the existing Graph subgraph tools with V4-specific data:
// hubs, spokes, cross-chain positions, and V4 reserves.
//
// STATUS: Aave V4 is not yet live. These tools will return a "not yet available"
// message until the API is reachable. Once V4 launches, they work automatically
// with no code changes needed.
//
// When V4 subgraphs become available on The Graph, these queries can be
// migrated to subgraphs by adding entries to subgraphs.ts and swapping
// the fetch target from api.aave.com to the Graph gateway.

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
      "Aave V4 is not yet live — the API at api.aave.com is not reachable. " +
      "These tools will work automatically once V4 launches. " +
      "For current Aave data, use the V2/V3 subgraph tools (get_aave_reserves, get_aave_user_position, etc.).",
      undefined,
      AAVE_API
    );
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 503) {
      throw new AaveV4ApiError(
        "Aave V4 API is not yet available (HTTP " + response.status + "). " +
        "V4 is coming soon. For current data, use V2/V3 subgraph tools.",
        response.status,
        AAVE_API
      );
    }
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
// Hubs — V4 liquidity hubs
// ---------------------------------------------------------------------------

export async function getV4Hubs(): Promise<unknown> {
  return gql(`
    query Hubs {
      hubs {
        id
        name
        chain { id name }
        deposits { amount currency }
        borrows { amount currency }
        availableLiquidity { amount currency }
        utilizationRate
      }
    }
  `);
}

// ---------------------------------------------------------------------------
// Spokes — V4 cross-chain spokes
// ---------------------------------------------------------------------------

export async function getV4Spokes(): Promise<unknown> {
  return gql(`
    query Spokes {
      spokes {
        id
        name
        chain { id name }
        hub { id name }
        reserves { id }
      }
    }
  `);
}

// ---------------------------------------------------------------------------
// Reserves — V4 reserve data
// ---------------------------------------------------------------------------

export async function getV4Reserves(chainId?: number): Promise<unknown> {
  const filter = chainId ? `, chainId: ${chainId}` : "";
  return gql(`
    query Reserves {
      reserves(request: { first: 50${filter} }) {
        id
        onChainId
        chain { id name }
        asset { symbol name decimals }
        summary {
          totalSupplied { amount currency }
          totalBorrowed { amount currency }
          availableLiquidity { amount currency }
          supplyApy
          borrowApy
          utilizationRate
        }
        settings {
          ltv
          liquidationThreshold
          liquidationBonus
          supplyCap { amount currency }
          borrowCap { amount currency }
          reserveFactor
        }
        status { isFrozen isPaused isActive }
        canBorrow
        canSupply
        canUseAsCollateral
      }
    }
  `);
}

// ---------------------------------------------------------------------------
// User positions — V4 cross-chain positions
// ---------------------------------------------------------------------------

export async function getV4UserPositions(userAddress: string): Promise<unknown> {
  return gql(
    `
    query UserPositions($request: UserPositionsRequest!) {
      userPositions(request: $request) {
        spoke { id name chain { id name } }
        healthFactor
        totalCollateral { amount currency }
        totalDebt { amount currency }
        borrowingPower { amount currency }
        supplies {
          reserve { asset { symbol name } }
          principal { amount currency }
          isCollateral
        }
        borrows {
          reserve { asset { symbol name } }
          principal { amount currency }
          interest { amount currency }
        }
      }
    }
  `,
    { request: { user: userAddress } }
  );
}

// ---------------------------------------------------------------------------
// User supplies — V4
// ---------------------------------------------------------------------------

export async function getV4UserSupplies(userAddress: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user: userAddress };
  if (chainId) request.chainId = chainId;
  return gql(
    `
    query UserSupplies($request: UserSuppliesRequest!) {
      userSupplies(request: $request) {
        reserve { asset { symbol name } chain { name } }
        principal { amount currency }
        interest { amount currency }
        isCollateral
        supplyApy
      }
    }
  `,
    { request }
  );
}

// ---------------------------------------------------------------------------
// User borrows — V4
// ---------------------------------------------------------------------------

export async function getV4UserBorrows(userAddress: string, chainId?: number): Promise<unknown> {
  const request: Record<string, unknown> = { user: userAddress };
  if (chainId) request.chainId = chainId;
  return gql(
    `
    query UserBorrows($request: UserBorrowsRequest!) {
      userBorrows(request: $request) {
        reserve { asset { symbol name } chain { name } }
        principal { amount currency }
        interest { amount currency }
        debt { amount currency }
        borrowApy
      }
    }
  `,
    { request }
  );
}
