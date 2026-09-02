import { queryChain } from "./graphClient.js";

// Aave V4 Omnigraph subgraph client + AaveKit JOIN helper.
// Returns Hub<->Spoke routing events that AaveKit's GraphQL API doesn't expose,
// enriched with human spoke names + asset symbols from AaveKit.

// The Omnigraph subgraph moved to the decentralized network; the old Studio URL
// is undeployed and answers HTTP 200 + {"message":"Not found"}, which is why
// this tool silently returned `flows: []` for weeks. Query the same deployment
// v4Omnigraph.ts uses, through the gateway. AAVE_V4_OMNIGRAPH_URL is still
// honoured for a self-hosted or Studio deployment.
const DEPLOYMENT_ID =
  process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID ||
  "QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs";
const SUBGRAPH_URL = process.env.AAVE_V4_OMNIGRAPH_URL || "";
// Same default and same override as aaveV4Api.ts. Hardcoding the alias here
// meant AAVE_V4_API_URL redirected half the server and not the other half.
const AAVEKIT_URL = process.env.AAVE_V4_API_URL || "https://api.v4.aave.com/graphql";

/**
 * POST a GraphQL query and fail loudly on anything that is not a GraphQL reply.
 *
 * The Studio gateway answers a missing/undeployed subgraph with HTTP **200**
 * and `{"message":"Not found"}` — no `errors` key. Code that only checked
 * `json.errors` therefore fell through to `data?.field || []` and reported an
 * absent backend as "zero results", which reads as "nothing happened on chain"
 * rather than "this tool is not working". That is the failure this guards.
 */
async function gqlPost<T>(url: string, query: string, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    throw new Error(
      `${label} unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  }
  let json: { data?: T; errors?: unknown[]; message?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON from ${url}: ${text.slice(0, 200)}`);
  }
  if (json.errors) {
    throw new Error(`${label} error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  if (json.data === undefined) {
    // The {"message":"Not found"} case, plus any other 200-with-no-data body.
    const hint =
      url === SUBGRAPH_URL
        ? " No Aave V4 Omnigraph subgraph is deployed at this URL." +
          " Unset AAVE_V4_OMNIGRAPH_URL to use the decentralized-network" +
          " deployment via the gateway, or point it at a live one."
        : "";
    throw new Error(
      `${label} returned no data from ${url}: ${text.slice(0, 160)}.${hint}`
    );
  }
  return json.data;
}

// In-process caches so the AaveKit lookups happen once per server run.
let spokeAddressToName: Map<string, string> | null = null;
let assetAddressToSymbol: Map<string, string> | null = null;

async function loadSpokeRegistry(): Promise<Map<string, string>> {
  if (spokeAddressToName) return spokeAddressToName;
  const data = await gqlPost<{ spokes?: Array<{ name: string; address: string }> }>(
    AAVEKIT_URL,
    `{ spokes(request: { query: { chainIds: [1] } }) { name address } }`,
    "AaveKit spokes"
  );
  const map = new Map<string, string>();
  for (const s of data.spokes || []) {
    map.set(s.address.toLowerCase(), s.name);
  }
  spokeAddressToName = map;
  return map;
}

async function loadAssetRegistry(): Promise<Map<string, string>> {
  if (assetAddressToSymbol) return assetAddressToSymbol;
  const data = await gqlPost<{
    reserves?: Array<{
      asset: { underlying: { address: string; info: { symbol: string } | null } };
    }>;
  }>(
    AAVEKIT_URL,
    `{ reserves(request: { query: { chainIds: [1] } }) {
        asset { underlying { address info { symbol } } }
      } }`,
    "AaveKit reserves"
  );
  const map = new Map<string, string>();
  for (const r of data.reserves || []) {
    const addr = r.asset.underlying.address.toLowerCase();
    const symbol = r.asset.underlying.info?.symbol || "?";
    map.set(addr, symbol);
  }
  assetAddressToSymbol = map;
  return map;
}

export type FlowType =
  | "ADD"
  | "REMOVE"
  | "DRAW"
  | "RESTORE"
  | "REFRESH_PREMIUM"
  | "REPORT_DEFICIT"
  | "TRANSFER_SHARES";

export type HubName = "Core" | "Plus" | "Prime";

export interface HubFlowsArgs {
  hubName?: HubName;
  spokeName?: string;
  flowTypes?: FlowType[];
  limit?: number;
  sinceMinutes?: number;
}

export interface EnrichedFlow {
  type: FlowType;
  hub: HubName | string;
  spoke: { address: string; name: string };
  counterpartySpoke?: { address: string; name: string };
  asset: { address: string; symbol: string; decimals: number };
  amount: string | null;
  amountHuman: number | null;
  drawnAmount: string | null;
  drawnAmountHuman: number | null;
  premiumAmount: string | null;
  deficitAmountRay: string | null;
  block: number;
  timestamp: number;
  txHash: string;
}

interface RawFlow {
  type: FlowType;
  hub: { name: string };
  spoke: { id: string } | null;
  counterpartySpoke: { id: string } | null;
  hubAsset: { underlying: string; decimals: number };
  amount: string | null;
  drawnAmount: string | null;
  premiumAmount: string | null;
  deficitAmountRay: string | null;
  block: string;
  timestamp: string;
  txHash: string;
}

function toHuman(raw: string | null, decimals: number): number | null {
  if (!raw) return null;
  const d = decimals > 0 ? decimals : 0;
  // BigInt-safe divide for very large numbers
  try {
    const big = BigInt(raw);
    const divisor = 10n ** BigInt(d);
    const whole = Number(big / divisor);
    const frac = Number(big % divisor) / Number(divisor);
    return whole + frac;
  } catch {
    return null;
  }
}

export async function getV4HubFlows(args: HubFlowsArgs): Promise<{
  flows: EnrichedFlow[];
  filterApplied: HubFlowsArgs;
  syncedBlock: number | null;
}> {
  const limit = Math.min(args.limit ?? 25, 200);
  const [spokeMap, assetMap] = await Promise.all([loadSpokeRegistry(), loadAssetRegistry()]);

  // Build the GraphQL where filter
  const whereParts: string[] = [];
  if (args.flowTypes && args.flowTypes.length > 0) {
    whereParts.push(`type_in: [${args.flowTypes.join(", ")}]`);
  }
  if (args.hubName) {
    // Map hub name to address (we know them)
    const HUB_ADDR: Record<string, string> = {
      Core: "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9",
      Plus: "0x06002e9c4412cb7814a791ea3666d905871e536a",
      Prime: "0x943827dca022d0f354a8a8c332da1e5eb9f9f931",
    };
    const addr = HUB_ADDR[args.hubName];
    if (addr) whereParts.push(`hub: "${addr}"`);
  }
  if (args.spokeName) {
    // Reverse lookup name → address
    let spokeAddr: string | undefined;
    for (const [addr, name] of spokeMap.entries()) {
      if (name.toLowerCase() === args.spokeName.toLowerCase()) {
        spokeAddr = addr;
        break;
      }
    }
    if (spokeAddr) whereParts.push(`spoke: "${spokeAddr}"`);
  }
  if (args.sinceMinutes && args.sinceMinutes > 0) {
    const sinceTs = Math.floor(Date.now() / 1000) - args.sinceMinutes * 60;
    whereParts.push(`timestamp_gte: "${sinceTs}"`);
  }
  const whereClause = whereParts.length > 0 ? `where: { ${whereParts.join(", ")} }` : "";

  const query = `{
    _meta { block { number } }
    hubSpokeFlows(first: ${limit}, orderBy: block, orderDirection: desc${
    whereClause ? ", " + whereClause : ""
  }) {
      type
      hub { name }
      spoke { id }
      counterpartySpoke { id }
      hubAsset { underlying decimals }
      amount drawnAmount premiumAmount deficitAmountRay
      block timestamp txHash
    }
  }`;

  type FlowsResult = {
    hubSpokeFlows?: RawFlow[];
    _meta?: { block?: { number: number } };
  };
  // Gateway by default (needs GRAPH_API_KEY); a direct URL only if one is set.
  const data = SUBGRAPH_URL
    ? await gqlPost<FlowsResult>(SUBGRAPH_URL, query, "Aave V4 Omnigraph")
    : ((await queryChain(DEPLOYMENT_ID, query)) as FlowsResult);
  const raw = data.hubSpokeFlows || [];
  const syncedBlock = data._meta?.block?.number ?? null;

  const flows: EnrichedFlow[] = raw.map((f) => {
    const spokeAddr = (f.spoke?.id || "").toLowerCase();
    const counterAddr = (f.counterpartySpoke?.id || "").toLowerCase();
    const assetAddr = f.hubAsset.underlying.toLowerCase();
    const decimals = f.hubAsset.decimals;
    return {
      type: f.type,
      hub: f.hub.name,
      spoke: { address: spokeAddr, name: spokeMap.get(spokeAddr) || "unknown" },
      counterpartySpoke: counterAddr
        ? { address: counterAddr, name: spokeMap.get(counterAddr) || "unknown" }
        : undefined,
      asset: { address: assetAddr, symbol: assetMap.get(assetAddr) || "?", decimals },
      amount: f.amount,
      amountHuman: toHuman(f.amount, decimals),
      drawnAmount: f.drawnAmount,
      drawnAmountHuman: toHuman(f.drawnAmount, decimals),
      premiumAmount: f.premiumAmount,
      deficitAmountRay: f.deficitAmountRay,
      block: parseInt(f.block, 10),
      timestamp: parseInt(f.timestamp, 10),
      txHash: f.txHash,
    };
  });

  return { flows, filterApplied: args, syncedBlock };
}
