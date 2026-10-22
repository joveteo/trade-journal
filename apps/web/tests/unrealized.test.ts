import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotatedTrade } from "@luxalgo/journal-core";
import type { MarketHistory } from "../src/lib/market-data";
import { latestPrice, summarizeMarks, unrealizedPnl } from "../src/lib/unrealized";
import type { HistoryRequest } from "../src/server/market-data/provider";

const history = vi.fn<(request: HistoryRequest) => Promise<MarketHistory>>();
vi.mock("../src/server/market-data/connections", () => ({
  providerFor: (id: string) => ({ id, name: "Test", history }),
  connectionKey: () => "",
}));
const { markOpenPositions } = await import("../src/server/market-data/unrealized");
const { MarketDataError } = await import("../src/server/market-data/provider");

const now = Date.parse("2026-10-04T06:00:00Z");
const bars = (...closes: number[]): MarketHistory => ({
  provider: "Test",
  symbol: "AAPL",
  resolution: "1m",
  fetchedAt: new Date(now).toISOString(),
  truncated: false,
  warnings: [],
  bars: closes.map((close, index) => ({
    time: now - (closes.length - index) * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  })),
});
const position = (fields: Partial<AnnotatedTrade> = {}) =>
  ({
    key: fields.symbol ?? "AAPL",
    accountId: "acct",
    symbol: "AAPL",
    assetClass: "equity",
    direction: "long",
    status: "open",
    openQuantity: 10,
    avgEntry: 100,
    ...fields,
  }) as AnnotatedTrade;
const mark = (positions: AnnotatedTrade[], currency = "USD") =>
  markOpenPositions(positions, {
    provider: "alpaca",
    dataset: "iex",
    currencyOf: () => currency,
    now,
  });

beforeEach(() => {
  history.mockReset();
});

describe("unrealised P&L math", () => {
  it("marks the remaining quantity against average entry with direction and multiplier", () => {
    expect(unrealizedPnl(position(), 105)).toBe(50);
    expect(unrealizedPnl(position({ direction: "short" }), 105)).toBe(-50);
    expect(
      unrealizedPnl(
        position({ assetClass: "option", contractMultiplier: 100, openQuantity: 2, avgEntry: 1.5 }),
        2,
      ),
    ).toBeCloseTo(100, 9);
  });

  it("withholds a value when a derivative has no multiplier", () => {
    expect(unrealizedPnl(position({ assetClass: "futures" }), 105)).toBeNull();
  });

  it("uses the most recent finite close", () => {
    expect(latestPrice(bars(1, 2, 3))?.price).toBe(3);
    expect(latestPrice(bars())).toBeNull();
  });

  it("totals only a single currency", () => {
    const base = { price: 1, priceTime: 0 };
    expect(
      summarizeMarks("Test", [
        { key: "a", symbol: "A", ...base, unrealizedPnl: 5, currency: "USD" },
        { key: "b", symbol: "B", ...base, unrealizedPnl: -2, currency: "USD" },
        {
          key: "c",
          symbol: "C",
          price: null,
          priceTime: null,
          unrealizedPnl: null,
          currency: "EUR",
        },
      ]),
    ).toMatchObject({ total: 3, currency: "USD", priced: 2 });
    expect(
      summarizeMarks("Test", [
        { key: "a", symbol: "A", ...base, unrealizedPnl: 5, currency: "USD" },
        { key: "b", symbol: "B", ...base, unrealizedPnl: 5, currency: "EUR" },
      ]).total,
    ).toBeNull();
  });
});

describe("marking open positions", () => {
  it("falls back to hourly candles when the market is closed", async () => {
    history.mockResolvedValueOnce(bars()).mockResolvedValueOnce({ ...bars(110), resolution: "1h" });
    const result = await mark([position()]);
    expect(history.mock.calls.map(([request]) => request.resolution)).toEqual(["1m", "1h"]);
    expect(result).toMatchObject({ total: 100, priced: 1, currency: "USD" });
  });

  it("never values option premium with underlying prices", async () => {
    history
      .mockResolvedValueOnce({ ...bars(5000), priceKind: "underlying" })
      .mockResolvedValueOnce({ ...bars(5000), resolution: "1h", priceKind: "underlying" });
    const result = await markOpenPositions(
      [position({ assetClass: "option", contractMultiplier: 100 })],
      {
        provider: "tastytrade",
        currencyOf: () => "USD",
        now,
      },
    );
    expect(result.total).toBeNull();
    expect(result.positions[0]!.issue).toMatch(/underlying/);
  });

  it("rejects incompatible providers and quote currencies without counting zero", async () => {
    history.mockResolvedValueOnce({ ...bars(110), quoteCurrency: "USDT" });
    const result = await mark([position(), position({ symbol: "EURUSD", assetClass: "forex" })]);
    expect(history).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ total: null, priced: 0 });
    expect(result.positions.map((p) => p.issue)).toEqual([
      expect.stringMatching(/quote currency/),
      expect.stringMatching(/Alpaca dataset/),
    ]);
  });

  it("stops requesting after three consecutive provider failures", async () => {
    history.mockImplementation(async () => {
      throw new MarketDataError("Rate limited.");
    });
    const symbols = ["A", "B", "C", "D"].map((symbol) => position({ symbol }));
    const result = await mark(symbols);
    expect(history).toHaveBeenCalledTimes(3);
    expect(result.positions.at(-1)!.issue).toBe("Not processed.");
  });
});
