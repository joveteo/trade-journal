/** Provider-neutral candles. Time is the UTC bar-open timestamp in milliseconds. */
export interface MarketBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const RESOLUTIONS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
} as const;
export type Resolution = keyof typeof RESOLUTIONS;
export const isResolution = (value: unknown): value is Resolution =>
  typeof value === "string" && Object.hasOwn(RESOLUTIONS, value);

export interface MarketConnection {
  id: string;
  name: string;
  configured: boolean;
  source: "environment" | "saved" | "public" | "uploaded" | null;
}

/** `/api/market-data/connections`: the default is preselected wherever a source is chosen. */
export interface MarketConnectionsState {
  connections: MarketConnection[];
  defaultProvider: string | null;
}

export interface MarketHistory {
  quoteCurrency?: string;
  datasetId?: string;
  provider: string;
  symbol: string;
  resolution: Resolution;
  bars: MarketBar[];
  fetchedAt: string;
  truncated: boolean;
  warnings: string[];
  /** Underlying candles used when option history is missing. Estimates and fill overlays stay off. */
  priceKind?: "instrument" | "underlying";
}

export interface ExcursionEstimate {
  priceBasisMismatch?: boolean;
  mae: number | null;
  mfe: number | null;
  sampledBars: number;
  excludedBars: number;
  warnings: string[];
}

export interface TradeMarketResult extends MarketHistory {
  estimate: ExcursionEstimate;
}
