import { describe, expect, it } from "vitest";
import {
  dxlinkOptionSymbol,
  occSymbol,
  combineVerticalCandles,
  resolveTastytradeInstrument,
  tastytradeCandleSymbol,
  tastytradeUnderlyingSymbol,
} from "../src/lib/tastytrade-symbols";

describe("Tastytrade journal symbols", () => {
  it("maps cash-index option roots to dxFeed underlyings", () => {
    expect(tastytradeUnderlyingSymbol("SPXW")).toBe("$SPX");
    expect(tastytradeUnderlyingSymbol("SPX")).toBe("$SPX");
    expect(tastytradeUnderlyingSymbol("$SPX")).toBe("$SPX");
    expect(tastytradeUnderlyingSymbol("AAPL")).toBe("AAPL");
    expect(tastytradeCandleSymbol(".SPXW260916C7665", "1m", "mark")).toBe(
      ".SPXW260916C7665{=1m,price=mark}",
    );
    expect(tastytradeCandleSymbol("AAPL", "1m")).toBe("AAPL{=1m}");
  });

  it("converts IBKR and OCC option tickers to dxFeed streamer symbols", () => {
    expect(
      dxlinkOptionSymbol({ underlying: "AAPL", expiry: "2025-01-17", strike: 150, right: "C" }),
    ).toBe(".AAPL250117C150");
    expect(occSymbol({ underlying: "SPXW", expiry: "2026-04-17", strike: 6865, right: "C" })).toBe(
      "SPXW  260417C06865000",
    );
    expect(resolveTastytradeInstrument("SPXW 17APR26 6865 C")).toMatchObject({
      kind: "option",
      streamer: ".SPXW260417C6865",
      underlying: "$SPX",
    });
    expect(resolveTastytradeInstrument(".SPY250107P580.5")).toMatchObject({
      kind: "option",
      streamer: ".SPY250107P580.5",
      underlying: "SPY",
    });
  });

  it("maps a vertical to both option legs and the cash-index fallback", () => {
    expect(resolveTastytradeInstrument("SPXW 13NOV25 6800/6815 C VERTICAL")).toMatchObject({
      kind: "vertical",
      underlying: "$SPX",
      right: "C",
      width: 15,
      lowStreamer: ".SPXW251113C6800",
      highStreamer: ".SPXW251113C6815",
    });
  });

  it("rebuilds each bar as sold credit minus bought debit and carries a quiet hedge", () => {
    const times = [1, 2, 3];
    const series = (prices: number[]) =>
      times.map((time, i) => ({
        time,
        open: prices[i]!,
        high: prices[i]! + 0.2,
        low: prices[i]! - 0.2,
        close: prices[i]!,
        volume: 10,
      }));
    const call = combineVerticalCandles(series([2.5, 2.6, 2.4]), series([1.8, 1.9, 1.7]), 15);
    expect(call.map((bar) => Number(bar.close.toFixed(4)))).toEqual([0.7, 0.7, 0.7]);
    expect(call[0]?.open).toBeCloseTo(0.7);
    expect(call[0]?.high).toBeCloseTo(0.7);
    expect(call[0]?.low).toBeCloseTo(0.7);
    const put = combineVerticalCandles(series([2.0, 1.9, 2.1]), series([1.3, 1.2, 1.4]), 15);
    expect(put.map((bar) => Number(bar.close.toFixed(4)))).toEqual([0.7, 0.7, 0.7]);
    expect(put[0]?.high).toBeCloseTo(0.7);
    expect(put[0]?.low).toBeCloseTo(0.7);
    const expanded = combineVerticalCandles(
      [{ time: 1, open: 2.5, high: 3.2, low: 2.3, close: 2.5, volume: 10 }],
      [{ time: 1, open: 1.8, high: 2.0, low: 1.6, close: 1.8, volume: 10 }],
      15,
    );
    expect(expanded[0]?.close).toBeCloseTo(0.7);
    expect(expanded[0]?.high).toBeCloseTo(1.2);
    expect(expanded[0]?.low).toBeCloseTo(0.7);
    const expiredHedge = combineVerticalCandles(
      [
        { time: 1, open: 9.2, high: 9.4, low: 9.0, close: 9.2, volume: 10 },
        { time: 2, open: 4.0, high: 4.1, low: 3.9, close: 4.0, volume: 10 },
        { time: 3, open: 0.1, high: 0.1, low: 0, close: 0, volume: 10 },
      ],
      [{ time: 1, open: 1.8, high: 1.9, low: 1.7, close: 1.8, volume: 10 }],
      15,
    );
    expect(expiredHedge.map((bar) => Number(bar.close.toFixed(4)))).toEqual([7.4, 2.2, 0]);
    expect(expiredHedge).toHaveLength(3);
  });
});
