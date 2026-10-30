import { describe, expect, it } from "vitest";
import { sessionDate, sessionPnl } from "../src/lib/benchmark";

describe("sessionDate", () => {
  it("keeps fills before the 16:00 ET close on that session in summer and winter", () => {
    expect(sessionDate("2026-07-15T19:59:59Z")).toBe("2026-07-15");
    expect(sessionDate("2026-12-15T20:59:59Z")).toBe("2026-12-15");
  });

  it("moves fills at or after the close to the next date", () => {
    expect(sessionDate("2026-07-15T20:00:00Z")).toBe("2026-07-16");
    expect(sessionDate("2026-12-15T21:00:00Z")).toBe("2026-12-16");
  });

  it("uses the New York date, not UTC, before midnight ET", () => {
    expect(sessionDate("2026-07-16T03:30:00Z")).toBe("2026-07-16");
  });
});

it("sums closed trades per session and skips open positions", () => {
  expect(
    sessionPnl([
      { status: "win", closedAt: "2026-07-15T14:00:00Z", netPnl: 10 },
      { status: "loss", closedAt: "2026-07-15T19:00:00Z", netPnl: -4 },
      { status: "win", closedAt: "2026-07-15T21:00:00Z", netPnl: 3 },
      { status: "open", closedAt: null, netPnl: 99 },
    ]),
  ).toEqual([
    { date: "2026-07-15", netPnl: 6 },
    { date: "2026-07-16", netPnl: 3 },
  ]);
});
