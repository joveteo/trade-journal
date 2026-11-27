import { expect, it } from "vitest";
import { buildRoundTrips, computeEdgeScore, computeOverview } from "../src";
import { fill } from "./helpers";

it.each(["fifo", "lifo", "wavg"] as const)(
  "%s matches a short across fractional lots while the aggregate remains open",
  (method) => {
    const firstCover = fill("BTC", "buy", 2.5e-9, 50_000, "2026-01-05T10:00:00Z", {
      fee: 0.00001,
    });
    const executions = [
      fill("BTC", "sell", 2e-9, 60_000, "2026-01-05T09:00:00Z"),
      fill("BTC", "sell", 2e-9, 70_000, "2026-01-05T09:30:00Z"),
      firstCover,
    ];
    const [open] = buildRoundTrips(executions, { method });
    expect(open).toMatchObject({ direction: "short", status: "open" });
    expect(open!.openQuantity).toBeCloseTo(1.5e-9, 15);
    expect(open!.exits[0]!.grossPnl).toBeCloseTo(
      { fifo: 0.00003, lifo: 0.000045, wavg: 0.0000375 }[method],
      12,
    );

    const closed = buildRoundTrips(
      [
        ...executions,
        fill("BTC", "buy", 1.5e-9, 55_000, "2026-01-05T10:30:00Z", { fee: 0.000005 }),
      ],
      { method },
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ status: "win", openQuantity: 0, executionCount: 4 });
    expect(closed[0]!.grossPnl).toBeCloseTo(0.0000525, 12);
    expect(closed[0]!.netPnl).toBeCloseTo(0.0000375, 12);
  },
);

it("uses the equity curve's close order for streaks when trades close simultaneously", () => {
  const at = "2026-01-06T04:30:00Z";
  const trades = buildRoundTrips([
    fill("AAPL", "buy", 1, 100, "2026-01-06T04:00:00Z"),
    fill("AAPL", "sell", 1, 120, at, { fee: 2 }),
    fill("MSFT", "buy", 1, 100, "2026-01-06T03:00:00Z"),
    fill("MSFT", "sell", 1, 85, at, { fee: 1 }),
    fill("SPY", "buy", 1, 100, "2026-01-05T20:00:00Z"),
    fill("SPY", "sell", 1, 101, "2026-01-05T21:00:00Z", { fee: 1 }),
    fill("TSLA", "buy", 1, 150, "2026-01-05T20:00:00Z"),
  ]);

  const options = { initialBalance: 100, timeZone: "America/New_York" };
  const overview = computeOverview(trades, options);
  expect(computeOverview([...trades].reverse(), options)).toEqual(overview);
  expect(overview.metrics).toMatchObject({
    closedTrades: 3,
    openTrades: 1,
    winRate: 1 / 3,
    expectancy: 2 / 3,
    maxDrawdown: 16,
    currentStreak: -1,
  });
  expect(overview.days).toMatchObject([{ date: "2026-01-05", netPnl: 2, trades: 3 }]);
  expect(overview.equity.map((point) => point.cumNetPnl)).toEqual([0, 18, 2]);
});

it("reports zero percentage drawdown for an uninterrupted winning run with a starting balance", () => {
  const trades = buildRoundTrips([
    fill("AAPL", "buy", 1, 100, "2026-01-06T04:00:00Z"),
    fill("AAPL", "sell", 1, 120, "2026-01-06T04:30:00Z", { fee: 2 }),
  ]);

  const backed = computeOverview(trades, { initialBalance: 100 }).metrics;
  expect(backed.maxDrawdown).toBe(0);
  expect(backed.maxDrawdownPct).toBe(0);
  expect(computeEdgeScore(backed).components.drawdown).toBe(100);

  const noBalance = computeOverview(trades).metrics;
  expect(noBalance.maxDrawdownPct).toBeNull();
  expect(computeEdgeScore(noBalance).components.drawdown).toBe(50);
});
