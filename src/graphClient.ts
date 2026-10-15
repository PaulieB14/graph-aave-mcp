export class GraphClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly graphErrors?: unknown[]
  ) {
    super(message);
    this.name = "GraphClientError";
  }
}

export async function queryChain(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    throw new GraphClientError(
      "GRAPH_API_KEY environment variable is required. " +
        "Get one free at https://thegraph.com/studio/apikeys/"
    );
  }

  const url = `https://gateway.thegraph.com/api/${apiKey}/deployments/id/${subgraphId}`;

  const body: Record<string, unknown> = { query };
  if (variables && Object.keys(variables).length > 0) {
    body.variables = variables;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new GraphClientError(
      `Graph API returned HTTP ${response.status}: ${response.statusText}`,
      response.status
    );
  }

  const json = (await response.json()) as {
    data?: unknown;
    errors?: unknown[];
  };

  if (json.errors && json.errors.length > 0) {
    throw new GraphClientError(
      `GraphQL errors: ${JSON.stringify(json.errors)}`,
      undefined,
      json.errors
    );
  }

  return json.data;
}

/**
 * Query a subgraph by its network *subgraph ID* (not deployment). The gateway
 * resolves it to the latest published version, so republishing doesn't
 * require a code change here.
 */
export async function querySubgraphId(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    throw new GraphClientError(
      "GRAPH_API_KEY environment variable is required. " +
        "Get one free at https://thegraph.com/studio/apikeys/"
    );
  }
  const url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
  const body: Record<string, unknown> = { query };
  if (variables && Object.keys(variables).length > 0) body.variables = variables;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new GraphClientError(
      `Graph API returned HTTP ${response.status}: ${response.statusText}`,
      response.status
    );
  }
  const json = (await response.json()) as { data?: unknown; errors?: unknown[] };
  if (json.errors && json.errors.length > 0) {
    throw new GraphClientError(`GraphQL errors: ${JSON.stringify(json.errors)}`, undefined, json.errors);
  }
  return json.data;
}
