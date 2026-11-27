import { expect, it } from "vitest";
import { buildRoundTrips } from "@luxalgo/journal-core";
import { parseWithMapping, positionFillProblem } from "../src";

const header =
  "Time,Symbol,Action,Size,Price,Fee,Contract,Position ID,Execution ID,Sequence,Account";
const mapping = {
  timestamp: "Time",
  symbol: "Symbol",
  side: "Action",
  quantity: "Size",
  price: "Price",
  fee: "Fee",
};
const at = "2026-01-05T14:30:00Z";

it("preserves same-time hedge fills, separate position IDs, and an explicit zero fee", () => {
  const result = parseWithMapping(
    [
      header,
      `${at},NQ,Close Long,1,110,0.02,NQH6,long-a,long-a-exit,3,broker-a`,
      `${at},NQ,Close Short,3,101,0.15,NQH6,short-a,short-a-exit,4,broker-a`,
      `${at},NQ,Open Long,2,100,0.10,NQH6,long-a,long-a-entry,0,broker-a`,
      `${at},NQ,Open Short,3,102,0.12,NQH6,short-a,short-a-entry,1,broker-a`,
      `${at},NQ,Open Long,1,104,0,NQH6,long-b,long-b-entry,2,broker-a`,
    ].join("\n"),
    mapping,
  );

  expect(result.errors).toBeUndefined();
  expect(result.skippedRows).toBe(0);
  expect(result.executions.map(positionFillProblem)).toEqual([null, null, null, null, null]);
  const zeroFee = result.executions[4]!;
  expect(zeroFee).toMatchObject({
    fee: 0,
    importMetadata: { id: "execution:long-b-entry", order: 2, preserveFee: true },
  });

  const trips = buildRoundTrips(
    result.executions.map((execution, index) => ({
      ...execution,
      id: String(index),
      accountId: "journal",
      source: "import",
    })),
  );
  expect(trips).toHaveLength(3);
  expect(trips).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ direction: "long", openQuantity: 1, avgEntry: 100, grossPnl: 10 }),
      expect.objectContaining({ direction: "long", openQuantity: 1, avgEntry: 104, fees: 0 }),
      expect.objectContaining({ direction: "short", status: "win", grossPnl: 3 }),
    ]),
  );
  expect(trips.find((trip) => trip.direction === "short")!.netPnl).toBeCloseTo(2.73, 10);
});

it("reports invalid explicit fill fields, mixed action styles, and mixed source accounts", () => {
  const result = parseWithMapping(
    [
      header,
      `${at},NQ,Open Long,2,100,bad,,,,1.5,broker-a`,
      `${at},NQ,Close Long,0,105,0,NQH6,long-a,exit,3,broker-a`,
      `${at},NQ,Open Short,1,110,0,NQH6,short-b,entry,4,broker-b`,
      `${at},NQ,Buy,1,110,0,NQH6,,,5,broker-a`,
    ].join("\n"),
    mapping,
  );

  expect(result.skippedRows).toBe(1);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Contract must be present"),
      expect.stringContaining("Position ID must be present"),
      expect.stringContaining("Execution ID must be present"),
      expect.stringContaining("Sequence must be a non-negative whole number"),
      expect.stringContaining("invalid fee"),
      expect.stringContaining("positive quantity"),
      expect.stringContaining("mixes Open/Close position labels"),
      expect.stringContaining("multiple source accounts"),
    ]),
  );
});

it("rejects position metadata whose grouping or execution side was changed after parsing", () => {
  const result = parseWithMapping(
    [header, `${at},NQ,Close Short,1,105,0,NQH6,short-a,exit,3,broker-a`].join("\n"),
    mapping,
  );
  const row = result.executions[0]!;
  const metadata = row.importMetadata!;
  const error = "NQ: invalid Open/Close position information.";

  expect(positionFillProblem(row)).toBeNull();
  expect(positionFillProblem({ ...row, side: "sell" })).toBe(error);
  expect(positionFillProblem({ ...row, importMetadata: { ...metadata, group: "other" } })).toBe(
    error,
  );
  expect(
    positionFillProblem({ ...row, importMetadata: { ...metadata, position: undefined } }),
  ).toBe(error);
});
