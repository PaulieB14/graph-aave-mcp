// Single source of truth for the Aave V4 Ethereum (Omnigraph) subgraph.
// Network subgraph ID 2Gu5HCAnWrNk2pXidscdhNEQhrwLgMKmssuCe9JhZhAe currently
// resolves to deployment QmcKrCRSPrMABEfQjyPF6DqhbY7zzcEj6h5QxQmKLcHFSs
// (verified via _meta.deployment). We query by subgraph ID so republishes are
// picked up automatically. Setting AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID pins a
// specific deployment instead.
import { queryChain, querySubgraphId } from "./graphClient.js";

export const V4_ETHEREUM_SUBGRAPH_ID =
  process.env.AAVE_V4_ETHEREUM_SUBGRAPH_ID || "2Gu5HCAnWrNk2pXidscdhNEQhrwLgMKmssuCe9JhZhAe";
export const V4_OMNIGRAPH_DEPLOYMENT_PIN = process.env.AAVE_V4_OMNIGRAPH_DEPLOYMENT_ID || "";

export const V4_ETHEREUM_TARGET: { kind: "subgraph" | "deployment"; id: string } =
  V4_OMNIGRAPH_DEPLOYMENT_PIN
    ? { kind: "deployment", id: V4_OMNIGRAPH_DEPLOYMENT_PIN }
    : { kind: "subgraph", id: V4_ETHEREUM_SUBGRAPH_ID };

/** Human-readable identifier for tool output. */
export const V4_OMNIGRAPH_DEPLOYMENT_ID = V4_ETHEREUM_TARGET.id;

export function queryV4Ethereum(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  return V4_ETHEREUM_TARGET.kind === "subgraph"
    ? querySubgraphId(V4_ETHEREUM_TARGET.id, query, variables)
    : queryChain(V4_ETHEREUM_TARGET.id, query, variables);
}
