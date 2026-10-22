import type { MarketHistory } from "./market-data";

export interface MarkablePosition {
  direction: string;
  openQuantity: number;
  avgEntry: number;
  assetClass?: string | null;
  contractMultiplier?: number | null;
}

export interface PositionMark {
  key: string;
  symbol: string;
  price: number | null;
  /** UTC bar-open time of the candle whose close supplied the price. */
  priceTime: number | null;
  unrealizedPnl: number | null;
  currency: string | null;
  issue?: string;
}

export interface UnrealizedSummary {
  provider: string;
  checkedAt: string;
  /** Null when no position was priced or priced positions span several currencies. */
  total: number | null;
  currency: string | null;
  priced: number;
  positions: PositionMark[];
}

/** Close of the most recent candle, or null when the history has no usable price. */
export function latestPrice(history: MarketHistory): { price: number; time: number } | null {
  for (let index = history.bars.length - 1; index >= 0; index--) {
    const bar = history.bars[index]!;
    if (Number.isFinite(bar.close)) return { price: bar.close, time: bar.time };
  }
  return null;
}

/** Remaining quantity marked against the average entry price, gross of fees. */
export function unrealizedPnl(position: MarkablePosition, price: number): number | null {
  const multiplier =
    position.contractMultiplier ??
    (["equity", "crypto"].includes(position.assetClass ?? "") ? 1 : null);
  if (multiplier === null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  if (![price, position.avgEntry, position.openQuantity].every(Number.isFinite)) return null;
  const sign = position.direction === "short" ? -1 : 1;
  return sign * (price - position.avgEntry) * position.openQuantity * multiplier;
}

export function summarizeMarks(
  provider: string,
  positions: PositionMark[],
  checkedAt = new Date().toISOString(),
): UnrealizedSummary {
  const priced = positions.filter((mark) => mark.unrealizedPnl !== null);
  const currencies = new Set(priced.map((mark) => mark.currency));
  const single = priced.length > 0 && currencies.size === 1;
  return {
    provider,
    checkedAt,
    total: single ? priced.reduce((total, mark) => total + mark.unrealizedPnl!, 0) : null,
    currency: single ? [...currencies][0]! : null,
    priced: priced.length,
    positions,
  };
}
