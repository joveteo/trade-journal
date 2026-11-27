import { expect, it } from "vitest";
import { parseAuto, parseMoney, parseTimestamp, readHeaders } from "../src";

it("auto-detects a tab-separated trade export after blank lines and quoted header punctuation", () => {
  const csv = [
    "\uFEFF",
    "   ",
    'Symbol\tSide\tQty\tFill Price\tClosing Time\t"Memo, with ; delimiters\nand a ""quote"""',
    'NASDAQ:AAPL\tBuy\t0.125\t185.50\t2026-01-05 09:31:00\t"first\nfill"',
  ].join("\r\n");

  expect(readHeaders(csv)).toEqual([
    "Symbol",
    "Side",
    "Qty",
    "Fill Price",
    "Closing Time",
    'Memo, with ; delimiters\nand a "quote"',
  ]);
  expect(parseAuto(csv, { timeZone: "America/New_York" })).toMatchObject({
    format: "tradingview",
    skippedRows: 0,
    executions: [
      { symbol: "AAPL", quantity: 0.125, price: 185.5, executedAt: "2026-01-05T14:31:00.000Z" },
    ],
  });
});

it("ignores commas in a quoted semicolon-separated header", () => {
  expect(readHeaders('"Name, desk, book";Price\rAAPL;20')).toEqual(["Name, desk, book", "Price"]);
});

it("retains fractional prices and fees with unambiguous decimal commas", () => {
  const csv = [
    "Date;Time;Symbol;Quantity;Price;Side;Commission;TransFee;ECNFee",
    "2026-01-05;09:31:00;EURUSD;0,125;1,09375;Buy;€-0,0125;€0,00125;€0,00025",
  ].join("\n");

  const result = parseAuto(csv);
  expect(result).toMatchObject({
    format: "tradervue",
    skippedRows: 0,
    executions: [{ symbol: "EURUSD", quantity: 0.125, price: 1.09375 }],
  });
  expect(result!.executions[0]!.fee).toBeCloseTo(0.014, 10);
  expect(parseMoney("€-1.234,56789")).toBe(-1234.56789);
  expect(parseMoney("1,234")).toBe(1234);
});

it.each(["$", "()", "-", "Infinity", "0x10"])("rejects a non-decimal amount %s", (input) => {
  expect(parseMoney(input)).toBeNaN();
});

it("rejects a nonexistent spring-forward time while preserving valid neighboring fills", () => {
  const zone = "America/New_York";
  expect(parseTimestamp("2026-03-08 01:59:59.999", zone)).toBe("2026-03-08T06:59:59.999Z");
  expect(parseTimestamp("2026-03-08 02:30:00", zone)).toBeNull();
  expect(parseTimestamp("2026-03-08 03:00:00", zone)).toBe("2026-03-08T07:00:00.000Z");
  expect(parseTimestamp("2026-03-08T02:30:00-05:00", zone)).toBe("2026-03-08T07:30:00.000Z");
});
