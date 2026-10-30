import type { BenchmarkSession } from "@luxalgo/journal-core";

export const BENCHMARK_SYMBOLS = ["SPY", "QQQ"] as const;
export type BenchmarkSymbol = (typeof BENCHMARK_SYMBOLS)[number];
export const isBenchmarkSymbol = (value: unknown): value is BenchmarkSymbol =>
  BENCHMARK_SYMBOLS.includes(value as BenchmarkSymbol);

/** `/api/benchmark`: daily sessions over all history matching the non-date filters. */
export interface BenchmarkPayload {
  symbol: BenchmarkSymbol;
  provider: string;
  providerName: string;
  /** "total" reinvests dividends; "price" is close-to-close only. */
  basis: "total" | "price";
  currency: string;
  initialBalance: number;
  /** First realized trade day, the default anchor for an all-history comparison. */
  firstTradeDate: string | null;
  /** Journal "today", for period-to-date windows. */
  today: string;
  sessions: BenchmarkSession[];
  warnings: string[];
}

const newYork = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** US session date of an instant: after the 16:00 ET close it belongs to the next session. */
export function sessionDate(iso: string): string {
  const parts = Object.fromEntries(
    newYork.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) < 16) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Realized net P&L per US session date. */
export function sessionPnl(trades: { status: string; closedAt?: string | null; netPnl: number }[]) {
  const days = new Map<string, number>();
  for (const trade of trades) {
    if (trade.status === "open" || !trade.closedAt) continue;
    const date = sessionDate(trade.closedAt);
    days.set(date, (days.get(date) ?? 0) + trade.netPnl);
  }
  return [...days]
    .map(([date, netPnl]) => ({ date, netPnl }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
