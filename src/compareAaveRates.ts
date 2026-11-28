/**
 * Live Aave V3 borrow and supply APYs across every mainnet market.
 *
 * The Graph subgraph list stops at the original deployments. Lido, EtherFi,
 * Horizon, BNB, Plasma, and the newer chains only show up on Aave's public
 * V3 API (no key). Rates here are the same figures the Aave UI reads.
 */

export const AAVE_V3_API_DEFAULT = "https://api.v3.aave.com/graphql";
export const AAVE_V3_TIMEOUT_MS = 20_000;
/** Share of available liquidity above which a sized trade would move the rate. */
export const LIQUIDITY_IMPACT_SHARE = 0.2;

export const DEFAULT_RATE_SYMBOLS = [
  "USDC",
  "USDT",
  "USDT0",
  "USDC.e",
  "GHO",
  "DAI",
  "USDS",
  "RLUSD",
  "PYUSD",
  "USDe",
] as const;

const MARKET_LABELS: Record<string, string> = {
  AaveV3Ethereum: "Ethereum Core",
  AaveV3EthereumLido: "Ethereum Lido",
  AaveV3EthereumEtherFi: "Ethereum EtherFi",
  AaveV3EthereumHorizon: "Ethereum Horizon",
  AaveV3Arbitrum: "Arbitrum",
  AaveV3Avalanche: "Avalanche",
  AaveV3Base: "Base",
  AaveV3BNB: "BNB",
  AaveV3Celo: "Celo",
  AaveV3Gnosis: "Gnosis",
  AaveV3Linea: "Linea",
  AaveV3Metis: "Metis",
  AaveV3Optimism: "Optimism",
  AaveV3Polygon: "Polygon",
  AaveV3Scroll: "Scroll",
  AaveV3Soneium: "Soneium",
  AaveV3Sonic: "Sonic",
  AaveV3ZkSync: "zkSync",
  AaveV3Plasma: "Plasma",
  AaveV3Ink: "Ink",
  AaveV3Mantle: "Mantle",
  AaveV3MegaETH: "MegaETH",
  AaveV3XLayer: "X Layer",
  AaveV3Monad: "Monad",
};

const CHAIN_LABELS: Record<string, string> = {
  BSC: "BNB",
};

export interface CompareAaveRatesInput {
  symbols?: string[];
  side?: "borrow" | "supply";
  minLiquidityUsd?: number;
  amountUsd?: number;
  excludePermissioned?: boolean;
}

export interface AaveV3RateReserve {
  underlyingToken?: { symbol?: string | null } | null;
  isFrozen?: boolean | null;
  isPaused?: boolean | null;
  supplyInfo?: {
    apy?: { formatted?: string | null; value?: string | null } | null;
    supplyCapReached?: boolean | null;
  } | null;
  borrowInfo?: {
    apy?: { formatted?: string | null; value?: string | null } | null;
    availableLiquidity?: {
      amount?: { value?: string | null } | null;
      usd?: string | number | null;
    } | null;
    borrowingState?: string | null;
  } | null;
}

export interface AaveV3RateMarket {
  name?: string | null;
  chain?: { name?: string | null; chainId?: number | string | null } | null;
  reserves?: AaveV3RateReserve[] | null;
}

export interface RankedRate {
  symbol: string;
  market: string;
  marketName: string;
  chain: string;
  chainId: number;
  borrowApyPct: number | null;
  supplyApyPct: number | null;
  borrowApy: string | null;
  supplyApy: string | null;
  apyPct: number | null;
  apy: string | null;
  availableLiquidityUsd: number | null;
  availableLiquidityTokens: string | null;
  borrowingState: string | null;
  isFrozen: boolean;
  isPaused: boolean;
  supplyCapReached: boolean;
  borrowable: boolean;
  suppliable: boolean;
  permissioned: boolean;
  restrictedCollateral: boolean;
  notes: string[];
  warnings: string[];
}

export interface FilteredRate {
  symbol: string;
  market: string;
  marketName: string;
  chain: string;
  chainId: number;
  availableLiquidityUsd: number | null;
  borrowingState: string | null;
  reason: string;
}

export interface CompareAaveRatesResult {
  source: string;
  fetchedAt: string;
  timeoutMs: number;
  side: "borrow" | "supply";
  symbols: string[];
  ranking: string;
  minLiquidityUsd: number | null;
  amountUsd: number | null;
  excludePermissioned: boolean;
  chains: { name: string; chainId: number }[];
  markets: {
    market: string;
    marketName: string;
    chain: string;
    chainId: number;
    permissioned: boolean;
    restrictedCollateral: boolean;
  }[];
  results: RankedRate[];
  filtered: FilteredRate[];
  notes: string[];
}

interface MarketAccess {
  permissioned: boolean;
  restrictedCollateral: boolean;
  notes: string[];
}

interface FetchDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  url: string;
}

/** USD₮0 and USDt compare equal to USDT0 and USDT. USDC does not match USDC.e. */
export function normalizeRateSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/₮/g, "T").replace(/\s+/g, "");
}

export function marketLabel(apiName: string): string {
  const known = MARKET_LABELS[apiName];
  if (known) return known;
  const spaced = apiName
    .replace(/^AaveV3/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced || apiName;
}

export function chainLabel(name: string): string {
  return CHAIN_LABELS[name] ?? name;
}

export function marketAccess(apiName: string): MarketAccess {
  const notes: string[] = [];
  const permissioned = /horizon/i.test(apiName);
  const etherfi = /etherfi/i.test(apiName);
  const lido = /lido/i.test(apiName);
  if (permissioned) {
    notes.push(
      "Horizon is a permissioned institutional market. Supplying and borrowing require an allowlisted address."
    );
  }
  if (etherfi) {
    notes.push(
      "EtherFi is a restricted-collateral market. Only EtherFi assets (weETH and related) count as collateral, so this is not a substitute for Ethereum Core."
    );
  }
  if (lido) {
    notes.push(
      "Lido is a restricted-collateral market. Collateral is limited to Lido staking assets (wstETH), so this is not a substitute for Ethereum Core."
    );
  }
  return { permissioned, restrictedCollateral: etherfi || lido, notes };
}

/** `value` is a fraction (0.043 = 4.3%). `formatted` is the UI percent ("4.36"). */
export function apyPercent(
  apy: { formatted?: string | null; value?: string | null } | null | undefined
): number | null {
  if (!apy) return null;
  if (apy.value != null && apy.value !== "") {
    const fraction = Number(apy.value);
    if (Number.isFinite(fraction)) return fraction * 100;
  }
  if (apy.formatted != null && apy.formatted !== "") {
    const n = Number(String(apy.formatted).replace("%", "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function roundPct(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatApy(pct: number | null, formatted?: string | null): string | null {
  if (pct == null) return null;
  if (formatted != null && String(formatted).trim() !== "") {
    const raw = String(formatted).replace("%", "").trim();
    if (raw) return `${raw}%`;
  }
  return `${pct.toFixed(2)}%`;
}

function usdNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function wantedSymbols(symbols: string[] | undefined): string[] {
  const raw = (symbols ?? []).map((s) => s.trim()).filter(Boolean);
  const list = raw.length > 0 ? raw : [...DEFAULT_RATE_SYMBOLS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const symbol of list) {
    const key = normalizeRateSymbol(symbol);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(symbol.trim());
  }
  return out;
}

function sortRates(rows: RankedRate[], side: "borrow" | "supply"): RankedRate[] {
  const usable = (row: RankedRate) => (side === "borrow" ? row.borrowable : row.suppliable);
  const apy = (row: RankedRate) =>
    (side === "borrow" ? row.borrowApyPct : row.supplyApyPct) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => {
    const aOk = usable(a);
    const bOk = usable(b);
    if (aOk !== bOk) return aOk ? -1 : 1;
    const aApy = apy(a);
    const bApy = apy(b);
    if (aApy !== bApy) return side === "supply" ? bApy - aApy : aApy - bApy;
    const aLiq = a.availableLiquidityUsd ?? -1;
    const bLiq = b.availableLiquidityUsd ?? -1;
    if (aLiq !== bLiq) return bLiq - aLiq;
    return (
      a.chain.localeCompare(b.chain) ||
      a.market.localeCompare(b.market) ||
      a.symbol.localeCompare(b.symbol)
    );
  });
}

export function rankAaveRates(
  markets: AaveV3RateMarket[],
  input: CompareAaveRatesInput = {}
): Omit<CompareAaveRatesResult, "source" | "fetchedAt" | "timeoutMs" | "chains"> {
  const side = input.side ?? "borrow";
  if (side !== "borrow" && side !== "supply") {
    throw new Error("side must be 'borrow' or 'supply'");
  }
  if (input.minLiquidityUsd != null && (!(input.minLiquidityUsd >= 0) || !Number.isFinite(input.minLiquidityUsd))) {
    throw new Error("minLiquidityUsd must be zero or a positive number");
  }
  if (input.amountUsd != null && (!(input.amountUsd > 0) || !Number.isFinite(input.amountUsd))) {
    throw new Error("amountUsd must be a positive number");
  }

  const symbols = wantedSymbols(input.symbols);
  const wanted = new Set(symbols.map(normalizeRateSymbol));
  const excludePermissioned = input.excludePermissioned === true;
  const minLiquidityUsd = input.minLiquidityUsd ?? null;
  const amountUsd = input.amountUsd ?? null;

  const results: RankedRate[] = [];
  const filtered: FilteredRate[] = [];
  const covered: CompareAaveRatesResult["markets"] = [];
  let sawHorizon = false;
  let sawEtherfi = false;
  let sawLido = false;

  for (const market of markets) {
    const marketName = market.name ?? "unknown";
    const access = marketAccess(marketName);
    const chainName = chainLabel(market.chain?.name ?? "unknown");
    const chainId = Number(market.chain?.chainId);
    covered.push({
      market: marketLabel(marketName),
      marketName,
      chain: chainName,
      chainId: Number.isFinite(chainId) ? chainId : 0,
      permissioned: access.permissioned,
      restrictedCollateral: access.restrictedCollateral,
    });

    for (const reserve of market.reserves ?? []) {
      const symbol = reserve.underlyingToken?.symbol ?? "";
      if (!symbol || !wanted.has(normalizeRateSymbol(symbol))) continue;
      if (access.permissioned) sawHorizon = true;
      if (/etherfi/i.test(marketName)) sawEtherfi = true;
      if (/lido/i.test(marketName)) sawLido = true;

      const isFrozen = Boolean(reserve.isFrozen);
      const isPaused = Boolean(reserve.isPaused);
      const supplyCapReached = Boolean(reserve.supplyInfo?.supplyCapReached);
      const borrowingState = reserve.borrowInfo?.borrowingState ?? null;
      const borrowApyPctRaw = apyPercent(reserve.borrowInfo?.apy);
      const supplyApyPctRaw = apyPercent(reserve.supplyInfo?.apy);
      const borrowApyPct = borrowApyPctRaw == null ? null : roundPct(borrowApyPctRaw);
      const supplyApyPct = supplyApyPctRaw == null ? null : roundPct(supplyApyPctRaw);
      const liquidityRaw = usdNumber(reserve.borrowInfo?.availableLiquidity?.usd);
      const availableLiquidityUsd = liquidityRaw == null ? null : roundUsd(liquidityRaw);
      const availableLiquidityTokens = reserve.borrowInfo?.availableLiquidity?.amount?.value ?? null;
      const borrowable = borrowingState === "ENABLED" && !isFrozen && !isPaused;
      const suppliable = !isFrozen && !isPaused && !supplyCapReached;

      const base = {
        symbol,
        market: marketLabel(marketName),
        marketName,
        chain: chainName,
        chainId: Number.isFinite(chainId) ? chainId : 0,
        availableLiquidityUsd,
        borrowingState,
      };

      if (excludePermissioned && access.permissioned) {
        filtered.push({
          ...base,
          reason: "Permissioned institutional market (Horizon) excluded.",
        });
        continue;
      }
      if (amountUsd != null && (availableLiquidityUsd == null || amountUsd > availableLiquidityUsd)) {
        filtered.push({
          ...base,
          reason:
            availableLiquidityUsd == null
              ? `amountUsd ${amountUsd} was excluded because available liquidity was not reported.`
              : `amountUsd ${amountUsd} exceeds available liquidity of ${availableLiquidityUsd} USD.`,
        });
        continue;
      }
      if (minLiquidityUsd != null && (availableLiquidityUsd == null || availableLiquidityUsd < minLiquidityUsd)) {
        filtered.push({
          ...base,
          reason:
            availableLiquidityUsd == null
              ? `Excluded because available liquidity was not reported (minLiquidityUsd ${minLiquidityUsd}).`
              : `Available liquidity ${availableLiquidityUsd} USD is below minLiquidityUsd ${minLiquidityUsd}.`,
        });
        continue;
      }

      const notes = [...access.notes];
      if (isPaused) notes.push("Reserve is paused.");
      else if (isFrozen) notes.push("Reserve is frozen. New borrows and new supply are blocked.");
      else if (borrowingState !== "ENABLED") {
        notes.push(`Borrowing is ${borrowingState ?? "unavailable"} on this reserve.`);
      }
      if (supplyCapReached) notes.push("Supply cap is reached.");

      const warnings: string[] = [];
      if (amountUsd != null && availableLiquidityUsd != null && availableLiquidityUsd > 0) {
        const share = amountUsd / availableLiquidityUsd;
        if (share > LIQUIDITY_IMPACT_SHARE) {
          warnings.push(
            `amountUsd is ${(share * 100).toFixed(1)}% of available liquidity ` +
              `($${amountUsd.toLocaleString("en-US")} vs $${availableLiquidityUsd.toLocaleString("en-US")}). ` +
              `A trade this large would move the rate.`
          );
        }
      }

      const sidePct = side === "borrow" ? borrowApyPct : supplyApyPct;
      const sideFormatted = side === "borrow" ? reserve.borrowInfo?.apy?.formatted : reserve.supplyInfo?.apy?.formatted;
      results.push({
        symbol,
        market: marketLabel(marketName),
        marketName,
        chain: chainName,
        chainId: Number.isFinite(chainId) ? chainId : 0,
        borrowApyPct,
        supplyApyPct,
        borrowApy: formatApy(borrowApyPct, reserve.borrowInfo?.apy?.formatted),
        supplyApy: formatApy(supplyApyPct, reserve.supplyInfo?.apy?.formatted),
        apyPct: sidePct,
        apy: formatApy(sidePct, sideFormatted),
        availableLiquidityUsd,
        availableLiquidityTokens,
        borrowingState,
        isFrozen,
        isPaused,
        supplyCapReached,
        borrowable,
        suppliable,
        permissioned: access.permissioned,
        restrictedCollateral: access.restrictedCollateral,
        notes,
        warnings,
      });
    }
  }

  const notes: string[] = [
    side === "borrow"
      ? "Sorted cheapest borrow APY first. Frozen, paused, and non-borrowable reserves are listed after markets you can borrow."
      : "Sorted by highest supply APY first. Frozen, paused, and supply-capped reserves are listed after markets you can supply.",
  ];
  if (sawHorizon) {
    notes.push(
      excludePermissioned
        ? "Horizon rows were excluded. Horizon is a permissioned institutional market."
        : "Horizon is a permissioned institutional market. Do not treat it as an open Core market."
    );
  }
  if (sawEtherfi) {
    notes.push("EtherFi restricts collateral to EtherFi assets (weETH and related).");
  }
  if (sawLido) {
    notes.push("Lido restricts collateral to Lido staking assets (wstETH).");
  }

  return {
    side,
    symbols,
    ranking:
      side === "borrow"
        ? "borrow APY ascending (cheapest first); unusable markets after"
        : "supply APY descending (best yield first); unusable markets after",
    minLiquidityUsd,
    amountUsd,
    excludePermissioned,
    markets: covered,
    results: sortRates(results, side),
    filtered,
    notes,
  };
}

function apiUrl(): string {
  const configured = process.env.AAVE_V3_API_URL?.trim();
  return configured || AAVE_V3_API_DEFAULT;
}

async function aaveV3Gql<T>(query: string, deps: FetchDeps): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Aave V3 API timed out after ${deps.timeoutMs}ms (${deps.url})`));
    }, deps.timeoutMs);
  });
  try {
    const response = await Promise.race([
      deps.fetchImpl(deps.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!response.ok) {
      throw new Error(`Aave V3 API HTTP ${response.status}: ${response.statusText} (${deps.url})`);
    }
    let json: { data?: T; errors?: Array<{ message?: string }> };
    try {
      json = (await Promise.race([response.json(), timeout])) as typeof json;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Aave V3 API")) throw error;
      throw new Error(`Aave V3 API returned a non-JSON response (HTTP ${response.status}) from ${deps.url}`);
    }
    if (json.errors?.length) {
      const message = json.errors.map((err) => err.message ?? "unknown error").join("; ");
      throw new Error(`Aave V3 GraphQL: ${message} (${deps.url})`);
    }
    if (json.data == null) {
      throw new Error(`Aave V3 API returned no data (${deps.url})`);
    }
    return json.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Aave V3 API")) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Aave V3 API timed out after ${deps.timeoutMs}ms (${deps.url})`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Aave V3 API at ${deps.url} is not reachable: ${message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const CHAINS_QUERY = `{
  chains(filter: MAINNET_ONLY) { name chainId isTestnet }
}`;

function marketsQuery(chainIds: number[]): string {
  return `{
    markets(request: { chainIds: [${chainIds.join(", ")}] }) {
      name
      chain { name chainId }
      reserves {
        underlyingToken { symbol }
        isFrozen
        isPaused
        supplyInfo { apy { formatted value } supplyCapReached }
        borrowInfo {
          apy { formatted value }
          availableLiquidity { amount { value } usd }
          borrowingState
        }
      }
    }
  }`;
}

interface ChainsPayload {
  chains?: { name?: string; chainId?: number | string; isTestnet?: boolean }[];
}

interface MarketsPayload {
  markets?: AaveV3RateMarket[];
}

export async function compareAaveRates(
  input: CompareAaveRatesInput = {},
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<CompareAaveRatesResult> {
  const timeoutMs =
    deps.timeoutMs != null && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : AAVE_V3_TIMEOUT_MS;
  const fetchDeps: FetchDeps = {
    fetchImpl: deps.fetch ?? fetch,
    timeoutMs,
    url: apiUrl(),
  };
  const chainsPayload = await aaveV3Gql<ChainsPayload>(CHAINS_QUERY, fetchDeps);
  const chains = (chainsPayload.chains ?? [])
    .filter((chain) => !chain.isTestnet)
    .map((chain) => ({
      name: chainLabel(chain.name ?? "unknown"),
      chainId: Number(chain.chainId),
    }))
    .filter((chain) => Number.isInteger(chain.chainId) && chain.chainId > 0);
  if (chains.length === 0) {
    throw new Error(`Aave V3 API returned no mainnet chains (${fetchDeps.url})`);
  }
  const marketsPayload = await aaveV3Gql<MarketsPayload>(
    marketsQuery(chains.map((chain) => chain.chainId)),
    fetchDeps
  );
  const ranked = rankAaveRates(marketsPayload.markets ?? [], input);
  return {
    source: fetchDeps.url,
    fetchedAt: new Date().toISOString(),
    timeoutMs,
    chains,
    ...ranked,
  };
}
