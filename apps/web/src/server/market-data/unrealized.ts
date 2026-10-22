import type { AnnotatedTrade } from "@luxalgo/journal-core";
import type { MarketHistory } from "@/lib/market-data";
import {
  latestPrice,
  summarizeMarks,
  unrealizedPnl,
  type PositionMark,
  type UnrealizedSummary,
} from "@/lib/unrealized";
import { providerAssetIssue } from "./compatibility";
import { connectionKey, providerFor } from "./connections";
import { MarketDataError } from "./provider";

export const MAX_MARKED_POSITIONS = 50;
const HOUR = 3_600_000;

/** Recent minute candles first; hourly candles cover weekends and closed sessions. */
async function recentHistory(
  fetchHistory: (resolution: "1m" | "1h", from: number) => Promise<MarketHistory>,
  now: number,
): Promise<MarketHistory> {
  const minutes = await fetchHistory("1m", now - 3 * HOUR);
  // An underlying fallback cannot price the position; retry hourly contract candles.
  if (latestPrice(minutes) && minutes.priceKind !== "underlying") return minutes;
  return fetchHistory("1h", now - 10 * 24 * HOUR);
}

/**
 * Price open positions sequentially from one configured provider using each
 * position's recorded symbol. Positions that cannot be priced reliably keep a
 * null P&L and an issue rather than counting as zero.
 */
export async function markOpenPositions(
  positions: AnnotatedTrade[],
  options: {
    provider: string;
    dataset?: string;
    currencyOf: (accountId: string) => string | null;
    signal?: AbortSignal;
    now?: number;
  },
): Promise<UnrealizedSummary> {
  const provider = providerFor(options.provider);
  const key = connectionKey(provider.id);
  const now = options.now ?? Date.now();
  const marks: PositionMark[] = [];
  let consecutiveFailures = 0;
  for (const position of positions.slice(0, MAX_MARKED_POSITIONS)) {
    const currency = options.currencyOf(position.accountId);
    const mark = (fields: Partial<PositionMark>) =>
      marks.push({
        key: position.key,
        symbol: position.symbol,
        price: null,
        priceTime: null,
        unrealizedPnl: null,
        currency,
        ...fields,
      });
    if (options.signal?.aborted || consecutiveFailures >= 3) {
      mark({ issue: "Not processed." });
      continue;
    }
    const assetIssue = providerAssetIssue(provider.id, position.assetClass, options.dataset);
    if (assetIssue) {
      mark({ issue: assetIssue });
      continue;
    }
    let history: MarketHistory;
    try {
      history = await recentHistory(
        (resolution, from) =>
          provider.history(
            {
              symbol: position.symbol,
              dataset: options.dataset,
              resolution,
              from,
              to: now,
              signal: options.signal,
            },
            key,
          ),
        now,
      );
      consecutiveFailures = 0;
    } catch (error) {
      if (!(error instanceof MarketDataError)) throw error;
      consecutiveFailures++;
      mark({ issue: error.message });
      continue;
    }
    const latest = latestPrice(history);
    if (!latest) {
      mark({ issue: "No recent candles were returned for this symbol." });
      continue;
    }
    if (history.priceKind === "underlying") {
      mark({
        issue: "Only underlying prices were available; the option premium could not be priced.",
      });
      continue;
    }
    if (history.quoteCurrency && history.quoteCurrency !== currency) {
      mark({
        price: latest.price,
        priceTime: latest.time,
        issue: `The quote currency (${history.quoteCurrency}) differs from this account (${currency ?? "unknown"}). No FX conversion is applied.`,
      });
      continue;
    }
    const pnl = unrealizedPnl(position, latest.price);
    mark({
      price: latest.price,
      priceTime: latest.time,
      unrealizedPnl: pnl,
      ...(pnl === null
        ? { issue: "Set this symbol's contract multiplier in Settings to value the position." }
        : {}),
    });
  }
  for (const position of positions.slice(MAX_MARKED_POSITIONS))
    marks.push({
      key: position.key,
      symbol: position.symbol,
      price: null,
      priceTime: null,
      unrealizedPnl: null,
      currency: options.currencyOf(position.accountId),
      issue: `Only the first ${MAX_MARKED_POSITIONS} open positions are priced per refresh.`,
    });
  return summarizeMarks(provider.name, marks, new Date(now).toISOString());
}
