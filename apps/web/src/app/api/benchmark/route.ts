import { dayKeyOf, readFilters } from "@luxalgo/journal-core";
import { asc } from "drizzle-orm";
import { accounts, db } from "@/db";
import { isBenchmarkSymbol, sessionPnl, type BenchmarkPayload } from "@/lib/benchmark";
import { providerInfo } from "@/lib/market-providers";
import { bad, handler, ok, requireValue } from "@/server/api";
import { currencyProjection } from "@/server/currency-conversion";
import { benchmarkSessions, benchmarkSource } from "@/server/market-data/benchmark";
import { connections } from "@/server/market-data/connections";
import { MarketDataError } from "@/server/market-data/provider";
import { getCurrencyConversion } from "@/server/settings";
import { queryTradeModels, type TradeFilters } from "@/server/trades-query";

/**
 * Daily strategy equity against a buy-and-hold ETF over all history matching
 * the filters. Date filters are ignored so every window has a prior close and
 * the equity earned before it; the client slices windows.
 */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("benchmark") ?? "SPY";
  requireValue(isBenchmarkSymbol(symbol), "Choose SPY or QQQ as the benchmark.");
  const source = benchmarkSource(connections());
  if (!source)
    return bad(
      "Connect Tastytrade, Alpaca or London Strategic Edge in Settings → Market data.",
      409,
    );

  const { from: _from, to: _to, ...filters }: TradeFilters = readFilters(url.searchParams);
  const accountRows = db.select().from(accounts).orderBy(asc(accounts.createdAt)).all();
  const selected = filters.accounts
    ? accountRows.filter((a) =>
        filters
          .accounts!.split(",")
          .map((id) => id.trim())
          .includes(a.id),
      )
    : accountRows;
  const { trades, initialBalance, scope } = currencyProjection(
    queryTradeModels(filters),
    selected,
    getCurrencyConversion(),
  );
  if (!scope.monetary || scope.currency !== "USD")
    return bad("The benchmark is quoted in USD. Filter to USD accounts or report in USD.", 409);
  if (!(initialBalance > 0))
    return bad("Set an initial balance on the account to compare it with a benchmark.", 409);

  const days = sessionPnl(trades);
  const today = dayKeyOf(new Date().toISOString(), "America/New_York");
  const firstTradeDate = days[0]?.date ?? null;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const from = firstTradeDate && firstTradeDate < yearStart ? firstTradeDate : yearStart;
  try {
    const loaded = await benchmarkSessions(source, symbol, from, days, request.signal);
    return ok({
      symbol,
      provider: source.id,
      providerName: providerInfo(source.id)?.name ?? source.id,
      basis: loaded.basis,
      currency: "USD",
      initialBalance,
      firstTradeDate,
      today,
      sessions: loaded.sessions,
      warnings: loaded.warnings,
    } satisfies BenchmarkPayload);
  } catch (error) {
    if (error instanceof MarketDataError) return bad(error.message, 502);
    throw error;
  }
});
