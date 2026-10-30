import {
  alignBenchmark,
  totalReturnIndex,
  type BenchmarkClose,
  type BenchmarkDividend,
} from "@luxalgo/journal-core";
import type { MarketConnection } from "@/lib/market-data";
import { connectionKey, providerFor } from "./connections";
import { MarketDataError } from "./provider";
import { tastytradeDividends } from "./tastytrade";

/** Sources that serve US ETF daily closes, preferring the one with dividend history. */
const SOURCES: { id: string; dataset?: string }[] = [
  { id: "tastytrade" },
  { id: "alpaca", dataset: "iex" },
  { id: "london-strategic-edge" },
];

export const benchmarkSource = (connections: MarketConnection[]) =>
  SOURCES.find((source) =>
    connections.some((connection) => connection.id === source.id && connection.configured),
  ) ?? null;

interface Loaded {
  closes: BenchmarkClose[];
  dividends: BenchmarkDividend[] | null;
  warnings: string[];
  at: number;
}

/** Daily closes change once a session; keep them briefly so dashboard reloads stay free. */
const TTL_MS = 30 * 60_000;
const cache = new Map<string, Loaded>();

async function load(
  source: { id: string; dataset?: string },
  symbol: string,
  from: string,
  signal?: AbortSignal,
): Promise<Loaded> {
  const id = `${source.id}|${symbol}|${from}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const key = connectionKey(source.id);
  const history = await providerFor(source.id).history(
    {
      symbol,
      dataset: source.dataset,
      resolution: "1d",
      from: Date.parse(`${from}T00:00:00Z`),
      to: Date.now(),
      signal,
    },
    key,
  );
  if (history.truncated)
    throw new MarketDataError(
      `${symbol} history from ${from} is longer than this source returns. Narrow the account filter.`,
    );
  if (history.quoteCurrency && history.quoteCurrency !== "USD")
    throw new MarketDataError(`${symbol} is quoted in ${history.quoteCurrency}, not USD.`);
  let dividends: BenchmarkDividend[] | null = null;
  const warnings: string[] = [];
  if (source.id === "tastytrade") {
    try {
      dividends = await tastytradeDividends(symbol, key, signal);
    } catch (error) {
      if (!(error instanceof MarketDataError)) throw error;
      warnings.push(`${symbol} dividends were unavailable, so this is a price return.`);
    }
  }
  const loaded = {
    closes: history.bars.map((bar) => ({
      date: new Date(bar.time).toISOString().slice(0, 10),
      close: bar.close,
    })),
    dividends,
    warnings,
    at: Date.now(),
  };
  cache.set(id, loaded);
  return loaded;
}

/**
 * Benchmark sessions from a week before `from` (so the first comparison has a
 * prior close) through the last completed session, with the strategy's
 * cumulative realized P&L attached.
 */
export async function benchmarkSessions(
  source: { id: string; dataset?: string },
  symbol: string,
  from: string,
  days: { date: string; netPnl: number }[],
  signal?: AbortSignal,
) {
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const loaded = await load(source, symbol, start, signal);
  if (loaded.closes.length < 2)
    throw new MarketDataError(`No ${symbol} daily closes were returned for this period.`);
  return {
    basis: loaded.dividends ? ("total" as const) : ("price" as const),
    warnings: loaded.warnings,
    sessions: alignBenchmark(days, totalReturnIndex(loaded.closes, loaded.dividends ?? [])),
  };
}
