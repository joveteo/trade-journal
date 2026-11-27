import { describe, expect, it } from "vitest";
import { computeMetrics, type AnnotatedTrade } from "@luxalgo/journal-core";
import { parseCurrencyConversion } from "../src/lib/currencies";
import { currencyProjection } from "../src/server/currency-conversion";

const trade: AnnotatedTrade = {
  key: "eu|EURUSD",
  accountId: "eu",
  symbol: "EURUSD",
  direction: "short",
  status: "loss",
  openedAt: "2026-01-05T09:00:00Z",
  closedAt: "2026-01-05T10:00:00Z",
  quantity: 100,
  openQuantity: 0,
  avgEntry: 1.125,
  avgExit: 1.225,
  grossPnl: -10,
  fees: 0.25,
  netPnl: -10.25,
  executionCount: 2,
  executionIds: ["entry", "exit"],
  exits: [{ executionId: "exit", grossPnl: -10, quantity: 100 }],
  annotations: { stopLoss: 1.25, profitTarget: 1, tags: ["breakout"] },
};
const accounts = [
  { id: "us", currency: "USD", initialBalance: 1_000 },
  { id: "eu", currency: "EUR", initialBalance: 800 },
];

describe("fixed-rate reporting currency", () => {
  it("converts balances, executions' exit attribution, and risk levels without rounding", () => {
    const source = structuredClone(trade);
    const settings = parseCurrencyConversion({
      enabled: true,
      reportingCurrency: "USD",
      rates: { EUR: 1.125 },
    });
    const projected = currencyProjection([source], accounts, settings);
    expect(projected.scope).toMatchObject({ currency: "USD", converted: true, monetary: true });
    expect(projected.initialBalance).toBe(1_900);
    expect(projected.trades[0]).toMatchObject({
      avgEntry: 1.265625,
      grossPnl: -11.25,
      fees: 0.28125,
      netPnl: -11.53125,
      exits: [{ executionId: "exit", grossPnl: -11.25, quantity: 100 }],
      annotations: { stopLoss: 1.40625, profitTarget: 1.125, tags: ["breakout"] },
    });
    const metrics = computeMetrics(projected.trades, { initialBalance: projected.initialBalance });
    expect(metrics.maxDrawdown).toBe(11.53125);
    expect(metrics.maxDrawdownPct).toBeCloseTo(11.53125 / 1_900, 12);
    expect(metrics.avgRealizedR).toBeCloseTo(computeMetrics([source]).avgRealizedR!, 12);
    expect(source).toEqual(trade);
  });

  it("withholds mixed-currency monetary totals until every source rate is saved", () => {
    const projected = currencyProjection([trade], accounts, {
      enabled: true,
      reportingCurrency: "USD",
      rates: {},
    });
    expect(projected).toEqual({
      trades: [],
      initialBalance: 0,
      scope: {
        currency: null,
        sourceCurrencies: ["EUR", "USD"],
        converted: false,
        monetary: false,
        missingCurrencies: ["EUR"],
      },
    });
  });

  it("rejects an override to the reporting currency's identity rate", () => {
    expect(() =>
      parseCurrencyConversion({ enabled: true, reportingCurrency: "USD", rates: { USD: 1.25 } }),
    ).toThrow("The reporting currency always has a rate of 1.");
  });
});
