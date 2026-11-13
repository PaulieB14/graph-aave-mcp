import { parseAbi } from "viem";
import { marketState, type MarketState } from "./stocksGap.js";
import { rpcClient, withRpcRetry } from "./rpcClient.js";

/**
 * Base Chainlink 24/5 US equity feeds used by Aave V4 Coinbase stocks.
 * Addresses checked 2026-11-04. The gap model covers the wider equity list;
 * these three are the feeds this tool reads on-chain.
 */
export const EQUITY_FEEDS = [
  { symbol: "TSLAc", address: "0xfaf869185383a24f8cb00e27bda6b63b9905dcb4" },
  { symbol: "NVDAc", address: "0x04689a41629776563e6822f76f2e57d148d28513" },
  { symbol: "AAPLc", address: "0x787f13dea48db0897cbcdd985de77809d837f988" },
] as const;

const AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

export function classifyFeedUpdate(
  state: MarketState,
  updatedAtSec: number
): { updatedDuringFreeze: boolean; anomaly: "weekend_update" | null } {
  const inside =
    updatedAtSec > state.freezeStartSec && updatedAtSec < state.freezeEndSec;
  return {
    updatedDuringFreeze: !state.open && inside,
    anomaly: !state.open && updatedAtSec > state.freezeStartSec ? "weekend_update" : null,
  };
}

export async function getOracleStatus(asOf?: Date) {
  return withRpcRetry("base", async () => {
    const client = rpcClient("base");
    const market = marketState(asOf ?? new Date());
    const feeds = [];
    for (const feed of EQUITY_FEEDS) {
      const address = feed.address as `0x${string}`;
      const round = await client.readContract({
        address,
        abi: AGGREGATOR_ABI,
        functionName: "latestRoundData",
      });
      let decimals = 8;
      try {
        decimals = Number(await client.readContract({
          address,
          abi: AGGREGATOR_ABI,
          functionName: "decimals",
        }));
      } catch {
        /* description/decimals are convenience fields */
      }
      let description: string = feed.symbol;
      try {
        description = await client.readContract({
          address,
          abi: AGGREGATOR_ABI,
          functionName: "description",
        });
      } catch {
        /* keep the symbol */
      }
      const updatedAt = Number(round[3]);
      const answer = round[1];
      const price = Number(answer) / 10 ** decimals;
      feeds.push({
        symbol: feed.symbol,
        feed: feed.address,
        description,
        answer: answer.toString(),
        decimals,
        price,
        updatedAt,
        updatedAtIso: new Date(updatedAt * 1000).toISOString(),
        ...classifyFeedUpdate(market, updatedAt),
      });
    }
    return {
      premise: market.premise,
      holidayCalendar: market.holidayCalendar,
      market,
      feeds,
      sources: [
        "Chainlink 24/5 tokenized-equity feeds on Base",
        "https://aave.com/blog/coinbase-tokenized-stocks",
      ],
      note:
        "anomaly=weekend_update means a feed timestamp falls after Friday 20:00 ET " +
        "while the session is still frozen — the 24/5 premise may have changed. " +
        "US market holidays are not on this clock (weekend window only).",
    };
  });
}
