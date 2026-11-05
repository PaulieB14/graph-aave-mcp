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

const GATEWAY_BASE = "https://gateway.thegraph.com/api";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Request timeout in ms (GRAPH_TIMEOUT_MS, default 15000). */
export function getTimeoutMs(): number {
  return envInt("GRAPH_TIMEOUT_MS", 15_000);
}
/** Max retries after the first attempt (GRAPH_MAX_RETRIES, default 3). */
export function getMaxRetries(): number {
  return envInt("GRAPH_MAX_RETRIES", 3);
}
/** Base backoff in ms, doubled per retry (GRAPH_RETRY_BASE_MS, default 500). */
export function getRetryBaseMs(): number {
  return envInt("GRAPH_RETRY_BASE_MS", 500);
}

/** Remove the API key (and any key-shaped URL path segment) from a string. */
export function redact(text: string, apiKey = process.env.GRAPH_API_KEY): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("[REDACTED]");
  return out.replace(/(gateway\.thegraph\.com\/api\/)(?!subgraphs\/|deployments\/)[^/\s"']+/g, "$1[REDACTED]");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gatewayPost(
  path: string,
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

  // Key goes in the Authorization header (documented by The Graph), never the URL,
  // so it can't leak through URL logging.
  const url = `${GATEWAY_BASE}/${path}`;
  const body: Record<string, unknown> = { query };
  if (variables && Object.keys(variables).length > 0) body.variables = variables;
  const payload = JSON.stringify(body);

  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();
  const baseMs = getRetryBaseMs();

  let lastError: GraphClientError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(baseMs * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const msg = aborted
        ? `Graph API request timed out after ${timeoutMs}ms`
        : `Graph API network error: ${err instanceof Error ? err.message : String(err)}`;
      lastError = new GraphClientError(redact(msg, apiKey));
      continue; // network errors and timeouts are retryable
    }

    try {
      if (!response.ok) {
        const err = new GraphClientError(
          redact(`Graph API returned HTTP ${response.status}: ${response.statusText}`, apiKey),
          response.status
        );
        if (isRetryableStatus(response.status)) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const json = (await response.json()) as { data?: unknown; errors?: unknown[] };
      if (json.errors && json.errors.length > 0) {
        throw new GraphClientError(
          redact(`GraphQL errors: ${JSON.stringify(json.errors)}`, apiKey),
          undefined,
          json.errors
        );
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  const attempts = maxRetries + 1;
  throw new GraphClientError(
    `${lastError?.message ?? "Graph API request failed"} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`,
    lastError?.statusCode
  );
}

/** Query a pinned subgraph *deployment* (IPFS hash). */
export async function queryChain(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  return gatewayPost(`deployments/id/${subgraphId}`, query, variables);
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
  return gatewayPost(`subgraphs/id/${subgraphId}`, query, variables);
}
