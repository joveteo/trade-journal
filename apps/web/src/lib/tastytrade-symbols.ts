import {
  parseOptionSymbol,
  parseVerticalSymbol,
  type OptionContract,
  type OptionRight,
} from "@luxalgo/journal-core";
import type { MarketBar } from "./market-data";

/** dxFeed streamer symbols for cash-index option roots. */
export const TASTYTRADE_INDEX_ROOTS: Record<string, string> = {
  DJX: "$DJX",
  NDX: "$NDX",
  NDXP: "$NDX",
  RUT: "$RUT",
  RUTW: "$RUT",
  SPX: "$SPX",
  SPXW: "$SPX",
  VIX: "$VIX",
  VIXW: "$VIX",
  XND: "$XND",
  XSP: "$XSP",
};

const DXLINK_OPTION = /^\.([A-Z0-9]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/;

export function tastytradeUnderlyingSymbol(root: string): string {
  const symbol = root.trim().toUpperCase();
  if (symbol.startsWith("$") && /^\$[A-Z0-9]+$/.test(symbol)) return symbol;
  return TASTYTRADE_INDEX_ROOTS[symbol] ?? symbol;
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");

export function occSymbol(contract: OptionContract): string {
  const [year, month, day] = contract.expiry.split("-").map(Number);
  const yymmdd = `${pad(year! % 100, 2)}${pad(month!, 2)}${pad(day!, 2)}`;
  const root = contract.underlying.slice(0, 6).padEnd(6, " ");
  const strike = pad(Math.round(contract.strike * 1000), 8);
  return `${root}${yymmdd}${contract.right}${strike}`;
}

export function dxlinkStrike(strike: number): string {
  if (!Number.isFinite(strike) || strike <= 0) return "";
  if (Number.isInteger(strike)) return String(strike);
  const fixed = strike.toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

export function dxlinkOptionSymbol(contract: OptionContract): string {
  const [year, month, day] = contract.expiry.split("-").map(Number);
  const yymmdd = `${pad(year! % 100, 2)}${pad(month!, 2)}${pad(day!, 2)}`;
  return `.${contract.underlying}${yymmdd}${contract.right}${dxlinkStrike(contract.strike)}`;
}

export function parseDxlinkOptionSymbol(symbol: string): OptionContract | null {
  const match = symbol.trim().toUpperCase().match(DXLINK_OPTION);
  if (!match) return null;
  const yy = Number(match[2]!.slice(0, 2));
  const mm = Number(match[2]!.slice(2, 4));
  const dd = Number(match[2]!.slice(4, 6));
  const strike = Number(match[4]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || !Number.isFinite(strike) || strike <= 0)
    return null;
  return {
    underlying: match[1]!,
    expiry: `20${pad(yy, 2)}-${pad(mm, 2)}-${pad(dd, 2)}`,
    strike,
    right: match[3] as "C" | "P",
  };
}

export type TastytradeInstrument =
  | {
      kind: "option";
      contract: OptionContract;
      streamer: string;
      underlying: string;
      occ: string;
    }
  | {
      kind: "vertical";
      underlying: string;
      right: OptionRight;
      width: number;
      low: OptionContract;
      high: OptionContract;
      lowStreamer: string;
      highStreamer: string;
    }
  | { kind: "streamer"; symbol: string; underlying?: string }
  | { kind: "equity"; symbol: string };

function verticalLeg(
  vertical: NonNullable<ReturnType<typeof parseVerticalSymbol>>,
  strike: number,
): OptionContract {
  return {
    underlying: vertical.underlying,
    expiry: vertical.expiry,
    strike,
    right: vertical.right,
  };
}

export function resolveTastytradeInstrument(symbol: string): TastytradeInstrument {
  const text = symbol.trim();
  if (!text) return { kind: "equity", symbol: "" };
  const vertical = parseVerticalSymbol(text);
  if (vertical) {
    const low = verticalLeg(vertical, vertical.lowStrike);
    const high = verticalLeg(vertical, vertical.highStrike);
    return {
      kind: "vertical",
      underlying: tastytradeUnderlyingSymbol(vertical.underlying),
      right: vertical.right,
      width: vertical.width,
      low,
      high,
      lowStreamer: dxlinkOptionSymbol(low),
      highStreamer: dxlinkOptionSymbol(high),
    };
  }
  const option = parseOptionSymbol(text) ?? parseDxlinkOptionSymbol(text);
  if (option)
    return {
      kind: "option",
      contract: option,
      streamer: text.startsWith(".") ? text.trim().toUpperCase() : dxlinkOptionSymbol(option),
      underlying: tastytradeUnderlyingSymbol(option.underlying),
      occ: occSymbol(option),
    };
  if (text.startsWith(".")) return { kind: "streamer", symbol: text.trim().toUpperCase() };
  return { kind: "equity", symbol: tastytradeUnderlyingSymbol(text) };
}

export function tastytradeCandleSymbol(
  streamer: string,
  resolution: string,
  price: "last" | "mark" = "last",
): string {
  return price === "mark"
    ? `${streamer}{=${resolution},price=mark}`
    : `${streamer}{=${resolution}}`;
}

function carryBar(bar: MarketBar, time: number): MarketBar {
  return {
    time,
    open: bar.close,
    high: bar.close,
    low: bar.close,
    close: bar.close,
    volume: 0,
  };
}

/**
 * Rebuild the spread as credit (sold / nearer-ATM) minus debit (bought / further-OTM)
 * from each leg's OHLC: open, high, low and close are subtracted fieldwise.
 *
 * Align on the union of timestamps and carry a missing leg forward at its last close.
 * An expired hedge that stops printing must not freeze the short; the package goes to
 * 0 when the sold contract expires worthless and you keep the credit.
 */
export function combineVerticalCandles(
  creditBars: MarketBar[],
  debitBars: MarketBar[],
  width: number,
): MarketBar[] {
  const creditByTime = new Map(creditBars.map((bar) => [bar.time, bar]));
  const debitByTime = new Map(debitBars.map((bar) => [bar.time, bar]));
  const times = [...new Set([...creditByTime.keys(), ...debitByTime.keys()])].sort((a, b) => a - b);
  const cap = Number.isFinite(width) && width > 0 ? width : Infinity;
  const clamp = (value: number) => Math.min(cap, Math.max(0, value));
  const combined: MarketBar[] = [];
  let lastCredit: MarketBar | undefined;
  let lastDebit: MarketBar | undefined;
  for (const time of times) {
    if (creditByTime.has(time)) lastCredit = creditByTime.get(time);
    if (debitByTime.has(time)) lastDebit = debitByTime.get(time);
    if (!lastCredit || !lastDebit) continue;
    const credit = creditByTime.get(time) ?? carryBar(lastCredit, time);
    const debit = debitByTime.get(time) ?? carryBar(lastDebit, time);
    const open = credit.open - debit.open;
    const close = credit.close - debit.close;
    const boundHigh = credit.high - debit.high;
    const boundLow = credit.low - debit.low;
    const bar = {
      time,
      open: clamp(open),
      close: clamp(close),
      high: clamp(Math.max(boundHigh, open, close)),
      low: clamp(Math.min(boundLow, open, close)),
      volume: Math.min(credit.volume, debit.volume),
    };
    if (
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < Math.max(bar.open, bar.close)
    )
      continue;
    combined.push(bar);
  }
  return combined;
}
