import { readFilters } from "@luxalgo/journal-core";
import { accounts, db } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { MarketDataError } from "@/server/market-data/provider";
import { markOpenPositions } from "@/server/market-data/unrealized";
import { queryTradeModels } from "@/server/trades-query";

/** Price the filtered open positions on explicit request; never called on page load. */
export const POST = handler(async (request: Request) => {
  const url = new URL(request.url);
  const body = await request.json();
  requireValue(body && typeof body.provider === "string", "Choose a market data provider.");
  requireValue(
    body.dataset === undefined ||
      (typeof body.dataset === "string" && /^[a-zA-Z0-9_-]{0,80}$/.test(body.dataset)),
    "Invalid dataset.",
  );
  const positions = queryTradeModels(readFilters(url.searchParams)).filter(
    (trade) => trade.status === "open",
  );
  const currencies = new Map(
    db
      .select({ id: accounts.id, currency: accounts.currency })
      .from(accounts)
      .all()
      .map((account) => [account.id, account.currency]),
  );
  try {
    return ok(
      await markOpenPositions(positions, {
        provider: body.provider,
        dataset: body.dataset || undefined,
        currencyOf: (accountId) => currencies.get(accountId) ?? null,
        signal: request.signal,
      }),
    );
  } catch (error) {
    if (error instanceof MarketDataError) return bad(error.message, 502);
    throw error;
  }
});
