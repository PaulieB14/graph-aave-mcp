// Aave V4 Omnigraph subgraph client + AaveKit JOIN helper.
// Returns Hub<->Spoke routing events that AaveKit's GraphQL API doesn't expose,
// enriched with human spoke names + asset symbols from AaveKit.

const SUBGRAPH_URL =
  process.env.AAVE_V4_OMNIGRAPH_URL ||
  "https://api.studio.thegraph.com/query/1745687/aave-v-4/v0.1.1";
const AAVEKIT_URL = "https://api.aave.com/graphql";

// In-process caches so the AaveKit lookups happen once per server run.
let spokeAddressToName: Map<string, string> | null = null;
let assetAddressToSymbol: Map<string, string> | null = null;

async function loadSpokeRegistry(): Promise<Map<string, string>> {
  if (spokeAddressToName) return spokeAddressToName;
  const res = await fetch(AAVEKIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ spokes(request: { query: { chainIds: [1] } }) { name address } }`,
    }),
  });
  const json = (await res.json()) as {
    data?: { spokes?: Array<{ name: string; address: string }> };
  };
  const map = new Map<string, string>();
  for (const s of json.data?.spokes || []) {
    map.set(s.address.toLowerCase(), s.name);
  }
  spokeAddressToName = map;
  return map;
}

async function loadAssetRegistry(): Promise<Map<string, string>> {
  if (assetAddressToSymbol) return assetAddressToSymbol;
  const res = await fetch(AAVEKIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ reserves(request: { query: { chainIds: [1] } }) {
        asset { underlying { address info { symbol } } }
      } }`,
    }),
  });
  const json = (await res.json()) as {
    data?: {
      reserves?: Array<{
        asset: { underlying: { address: string; info: { symbol: string } | null } };
      }>;
    };
  };
  const map = new Map<string, string>();
  for (const r of json.data?.reserves || []) {
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

  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as {
    data?: { hubSpokeFlows?: RawFlow[]; _meta?: { block?: { number: number } } };
    errors?: unknown[];
  };
  if (json.errors) {
    throw new Error(`Omnigraph error: ${JSON.stringify(json.errors)}`);
  }
  const raw = json.data?.hubSpokeFlows || [];
  const syncedBlock = json.data?._meta?.block?.number ?? null;

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
