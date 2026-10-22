import {
  readFilters,
  byDirection,
  byDuration,
  byHour,
  byMistake,
  byPlaybook,
  bySymbol,
  byTag,
  byWeekday,
  calendarMonthFromDays,
  computeEdgeScore,
  computeOverview,
  dailyCumulativeFromDays,
  dayKeyOf,
} from "@luxalgo/journal-core";
import { asc } from "drizzle-orm";
import { accounts, db, playbooks } from "@/db";
import { calendarRunningPnl } from "@/lib/calendar-insights";
import { handler, ok } from "@/server/api";
import { getTimeZone, getCurrencyConversion } from "@/server/settings";
import { currencyProjection } from "@/server/currency-conversion";
import { queryTradeModels, type TradeFilters } from "@/server/trades-query";

type StatsView = "dashboard" | "overview" | "full";

const requestedView = (url: URL): StatsView => {
  const view = url.searchParams.get("view");
  return view === "dashboard" || view === "overview" ? view : "full";
};

/** Return only the analytics blocks required by the requesting screen. */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const view = requestedView(url);
  const timeZone = getTimeZone();
  const filters: TradeFilters = readFilters(url.searchParams);

  const originalTrades = queryTradeModels(filters);
  const accountRows = db.select().from(accounts).orderBy(asc(accounts.createdAt)).all();
  const selected = filters.accounts
    ? accountRows.filter((a) =>
        filters
          .accounts!.split(",")
          .map((id) => id.trim())
          .includes(a.id),
      )
    : accountRows;
  const {
    trades,
    initialBalance,
    scope: currencyScope,
  } = currencyProjection(originalTrades, selected, getCurrencyConversion());

  const accountCurrencies = new Map(accountRows.map((a) => [a.id, a.currency]));
  const currencies = currencyScope.monetary
    ? [currencyScope.currency ?? "USD"]
    : currencyScope.sourceCurrencies;
  const directory =
    view === "dashboard"
      ? {}
      : {
          currencies,
          accounts: accountRows.map((a) => ({ id: a.id, name: a.name })),
          playbooks: db.select({ id: playbooks.id, name: playbooks.name }).from(playbooks).all(),
        };
  const buckets =
    view === "dashboard"
      ? { hour: byHour(trades, timeZone) }
      : {
          symbol: bySymbol(trades).slice(0, 20),
          tag: byTag(trades),
          mistake: byMistake(trades),
          playbook: byPlaybook(trades),
          weekday: byWeekday(trades, timeZone),
          hour: byHour(trades, timeZone),
          duration: byDuration(trades),
          direction: byDirection(trades),
        };
  if (view === "overview") return ok({ timeZone, ...directory, currencyScope, buckets });

  const { metrics, days, equity } = computeOverview(trades, { timeZone, initialBalance });

  const today = dayKeyOf(new Date().toISOString(), timeZone);
  const calendarYear = Number(url.searchParams.get("calYear") ?? today.slice(0, 4));
  const calendarMonthNum = Number(url.searchParams.get("calMonth") ?? today.slice(5, 7));
  const calendarPrefix = `${calendarYear}-${String(calendarMonthNum).padStart(2, "0")}`;
  const calendarTrades = trades.filter(
    (trade) =>
      trade.status !== "open" &&
      trade.closedAt &&
      dayKeyOf(trade.closedAt, timeZone).startsWith(calendarPrefix),
  );
  return ok({
    timeZone,
    ...directory,
    currencies,
    currencyScope,
    currencyGroups: currencyScope.monetary
      ? []
      : currencyScope.sourceCurrencies.map((currency) => {
          const groupAccounts = selected.filter((account) => account.currency === currency);
          const groupTrades = originalTrades.filter(
            (trade) => accountCurrencies.get(trade.accountId) === currency,
          );
          return {
            currency,
            metrics: computeOverview(groupTrades, {
              timeZone,
              initialBalance: groupAccounts.reduce(
                (sum, account) => sum + account.initialBalance,
                0,
              ),
            }).metrics,
          };
        }),
    metrics: currencyScope.monetary ? metrics : null,
    edgeScore: currencyScope.monetary ? computeEdgeScore(metrics) : null,
    days,
    dailyCumulative: dailyCumulativeFromDays(days),
    ...(view === "full" ? { equity } : {}),
    calendar: calendarMonthFromDays(days, calendarYear, calendarMonthNum),
    calendarCurrencies: currencies,
    runningPnl: currencyScope.monetary ? calendarRunningPnl(calendarTrades, timeZone) : {},
    buckets,
    openPositions: originalTrades
      .filter((t) => t.status === "open")
      .map((t) => ({
        key: t.key,
        symbol: t.symbol,
        direction: t.direction,
        openedAt: t.openedAt,
        quantity: t.openQuantity,
        avgEntry: t.avgEntry,
        currency: accountCurrencies.get(t.accountId) ?? "USD",
      })),
    recentTrades: [...(currencyScope.monetary ? trades : originalTrades)]
      .filter((t) => t.status !== "open")
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
      .slice(0, 10)
      .map((t) => ({
        key: t.key,
        symbol: t.symbol,
        closedAt: t.closedAt,
        netPnl: t.netPnl,
        currency: currencyScope.monetary
          ? (currencyScope.currency ?? "USD")
          : (accountCurrencies.get(t.accountId) ?? "USD"),
        status: t.status,
      })),
    initialBalance,
  });
});
