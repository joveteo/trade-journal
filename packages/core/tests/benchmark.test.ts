import { describe, expect, it } from "vitest";
import {
  alignBenchmark,
  benchmarkWindow,
  MIN_RETURN_SAMPLES,
  periodStarts,
  totalReturnIndex,
} from "../src";

describe("totalReturnIndex", () => {
  it("reinvests a dividend at the ex-date close", () => {
    const index = totalReturnIndex(
      [
        { date: "2026-09-17", close: 100 },
        { date: "2026-09-18", close: 99 },
        { date: "2026-09-21", close: 101 },
      ],
      [{ date: "2026-09-18", amount: 1 }],
    );
    expect(index.map((point) => point.index)).toEqual([1, 1, 1 * (101 / 99)]);
  });

  it("counts a non-session ex-date on the next session and ignores earlier dividends", () => {
    const index = totalReturnIndex(
      [
        { date: "2026-01-02", close: 50 },
        { date: "2026-01-05", close: 50 },
      ],
      [
        { date: "2026-01-02", amount: 5 },
        { date: "2026-01-03", amount: 0.5 },
      ],
    );
    expect(index[1]!.index).toBeCloseTo(1.01, 12);
  });

  it("is a price return without dividends", () => {
    const index = totalReturnIndex([
      { date: "2026-01-02", close: 200 },
      { date: "2026-01-05", close: 210 },
    ]);
    expect(index[1]!.index).toBeCloseTo(1.05, 12);
  });
});

describe("alignBenchmark", () => {
  it("rolls non-session P&L into the next session and drops P&L after the last one", () => {
    const sessions = alignBenchmark(
      [
        { date: "2026-01-01", netPnl: 10 },
        { date: "2026-01-03", netPnl: 5 },
        { date: "2026-01-05", netPnl: 1 },
        { date: "2026-01-07", netPnl: 100 },
      ],
      [
        { date: "2026-01-02", index: 1 },
        { date: "2026-01-05", index: 1.1 },
        { date: "2026-01-06", index: 1.2 },
      ],
    );
    expect(sessions.map((s) => s.strategy)).toEqual([10, 16, 16]);
  });
});

describe("benchmarkWindow", () => {
  const sessions = [
    { date: "2026-03-31", strategy: 500, index: 1 },
    { date: "2026-04-01", strategy: 700, index: 1.02 },
    { date: "2026-04-02", strategy: 600, index: 0.99 },
    { date: "2026-04-03", strategy: 900, index: 1.01 },
  ];

  it("anchors at the prior session close with equity including earlier P&L", () => {
    const window = benchmarkWindow(sessions, 9_500, { from: "2026-04-01" })!;
    expect(window.anchorDate).toBe("2026-03-31");
    expect(window.capital).toBe(10_000);
    expect(window.points.map((p) => p.strategyPnl)).toEqual([0, 200, 100, 400]);
    expect(window.points.map((p) => p.benchmarkPnl)[1]).toBeCloseTo(200, 9);
    expect(window.points.map((p) => p.drawdown)).toEqual([0, 0, -100, 0]);
    expect(window.strategyReturn).toBeCloseTo(0.04, 12);
    expect(window.benchmarkReturn).toBeCloseTo(0.01, 12);
    expect(window.excessReturn).toBeCloseTo(0.03, 12);
    expect(window.strategyMaxDrawdownPct).toBeCloseTo(100 / 10_200, 12);
    expect(window.benchmarkMaxDrawdownPct).toBeCloseTo(0.03 / 1.02, 12);
    expect(window.beta).toBeNull();
    expect(window.sessions).toBe(3);
  });

  it("uses the first session when the range starts before history and honours `to`", () => {
    const window = benchmarkWindow(sessions, 9_500, { from: "2026-01-01", to: "2026-04-02" })!;
    expect(window.anchorDate).toBe("2026-03-31");
    expect(window.points).toHaveLength(3);
  });

  it("needs positive equity and two sessions", () => {
    expect(benchmarkWindow(sessions, -500)).toBeNull();
    expect(benchmarkWindow(sessions, 9_500, { from: "2026-05-01" })).toBeNull();
  });

  it("reports a beta of one for a strategy that tracks the index", () => {
    const tracked = Array.from({ length: MIN_RETURN_SAMPLES + 1 }, (_, i) => {
      const index = 1 + 0.01 * Math.sin(i + 1) + i * 0.001;
      return { date: `2026-01-${String(i + 1).padStart(2, "0")}`, index };
    });
    const window = benchmarkWindow(
      tracked.map((s) => ({ ...s, strategy: 10_000 * (s.index / tracked[0]!.index - 1) })),
      10_000,
    )!;
    expect(window.beta).toBeCloseTo(1, 9);
    expect(window.correlation).toBeCloseTo(1, 9);
  });
});

it("finds week, month, quarter and year starts", () => {
  expect(periodStarts("2026-10-30")).toEqual({
    week: "2026-10-26",
    month: "2026-10-01",
    quarter: "2026-10-01",
    year: "2026-01-01",
  });
  expect(periodStarts("2026-03-01").week).toBe("2026-02-23");
});
