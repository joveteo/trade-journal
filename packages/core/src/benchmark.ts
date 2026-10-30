/** Buy-and-hold index comparisons for a strategy's realized daily equity. */

export interface BenchmarkClose {
  /** Exchange session date, YYYY-MM-DD. */
  date: string;
  close: number;
}

export interface BenchmarkDividend {
  /** Ex-dividend date, YYYY-MM-DD. */
  date: string;
  amount: number;
}

export interface BenchmarkSession {
  date: string;
  /** Cumulative realized net P&L of the strategy through this session, all history. */
  strategy: number;
  /** Benchmark growth index; ratios between sessions are the holding-period returns. */
  index: number;
}

/**
 * Growth index from unadjusted closes. Cash dividends are reinvested at the
 * ex-date close, so the result is a total return. A dividend whose ex-date is
 * not a session counts on the next session. Without dividends it is a price return.
 */
export function totalReturnIndex(
  closes: BenchmarkClose[],
  dividends: BenchmarkDividend[] = [],
): { date: string; index: number }[] {
  const bars = closes.filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
  const divs = [...dividends].sort((a, b) => a.date.localeCompare(b.date));
  let next = 0;
  while (next < divs.length && bars[0] && divs[next]!.date <= bars[0].date) next++;
  let index = 1;
  return bars.map((bar, i) => {
    if (i > 0) {
      let paid = 0;
      while (next < divs.length && divs[next]!.date <= bar.date) paid += divs[next++]!.amount;
      index *= (bar.close + paid) / bars[i - 1]!.close;
    }
    return { date: bar.date, index };
  });
}

/**
 * Attach the strategy's cumulative realized P&L to each benchmark session.
 * P&L realized on a non-session date (weekend crypto, holidays) counts on the
 * next session; P&L after the last session is not shown yet.
 */
export function alignBenchmark(
  days: { date: string; netPnl: number }[],
  index: { date: string; index: number }[],
): BenchmarkSession[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let cursor = 0;
  let cum = 0;
  return index.map((session) => {
    while (cursor < sorted.length && sorted[cursor]!.date <= session.date)
      cum += sorted[cursor++]!.netPnl;
    return { date: session.date, strategy: cum, index: session.index };
  });
}

export interface BenchmarkPoint {
  date: string;
  strategyPnl: number;
  benchmarkPnl: number;
  /** Strategy fall from its running peak in this window, zero or negative. */
  drawdown: number;
}

export interface BenchmarkWindow {
  /** Prior session close the window is measured from. */
  anchorDate: string;
  /** Account equity at the anchor: initial balance plus earlier realized P&L. */
  capital: number;
  points: BenchmarkPoint[];
  strategyReturn: number;
  benchmarkReturn: number;
  excessReturn: number;
  strategyMaxDrawdownPct: number;
  benchmarkMaxDrawdownPct: number;
  /** Daily-return beta and correlation; null below `MIN_RETURN_SAMPLES` sessions. */
  beta: number | null;
  correlation: number | null;
  sessions: number;
}

export const MIN_RETURN_SAMPLES = 20;

const maxDrawdownPct = (values: number[]) => {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
  }
  return worst;
};

const regression = (strategy: number[], benchmark: number[]) => {
  if (strategy.length < MIN_RETURN_SAMPLES) return { beta: null, correlation: null };
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const ms = mean(strategy);
  const mb = mean(benchmark);
  let cov = 0;
  let vs = 0;
  let vb = 0;
  strategy.forEach((value, i) => {
    cov += (value - ms) * (benchmark[i]! - mb);
    vs += (value - ms) ** 2;
    vb += (benchmark[i]! - mb) ** 2;
  });
  return {
    beta: vb > 0 ? cov / vb : null,
    correlation: vs > 0 && vb > 0 ? cov / Math.sqrt(vs * vb) : null,
  };
};

/**
 * Compare the strategy with buying the benchmark at the prior session close
 * using the same account equity. `from` and `to` are inclusive date keys; the
 * anchor is the last session before `from`, or the first session when none is.
 * Returns null when the window has no sessions or the equity at the anchor is not positive.
 */
export function benchmarkWindow(
  sessions: BenchmarkSession[],
  initialBalance: number,
  range: { from?: string; to?: string } = {},
): BenchmarkWindow | null {
  const inRange = sessions.filter((s) => !range.to || s.date <= range.to);
  let anchorAt = 0;
  if (range.from)
    while (inRange[anchorAt + 1] && inRange[anchorAt + 1]!.date < range.from) anchorAt++;
  const window = inRange.slice(anchorAt);
  const anchor = window[0];
  if (!anchor || window.length < 2) return null;
  const capital = initialBalance + anchor.strategy;
  if (!(capital > 0)) return null;

  let peak = 0;
  const points = window.map((session) => {
    const strategyPnl = session.strategy - anchor.strategy;
    peak = Math.max(peak, strategyPnl);
    return {
      date: session.date,
      strategyPnl,
      benchmarkPnl: capital * (session.index / anchor.index - 1),
      drawdown: strategyPnl - peak,
    };
  });
  const equity = points.map((point) => capital + point.strategyPnl);
  const strategyReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (!(equity[i - 1]! > 0)) continue;
    strategyReturns.push(equity[i]! / equity[i - 1]! - 1);
    benchmarkReturns.push(window[i]!.index / window[i - 1]!.index - 1);
  }
  const last = points[points.length - 1]!;
  const strategyReturn = last.strategyPnl / capital;
  const benchmarkReturn = last.benchmarkPnl / capital;
  return {
    anchorDate: anchor.date,
    capital,
    points,
    strategyReturn,
    benchmarkReturn,
    excessReturn: strategyReturn - benchmarkReturn,
    strategyMaxDrawdownPct: maxDrawdownPct(equity),
    benchmarkMaxDrawdownPct: maxDrawdownPct(window.map((session) => session.index)),
    ...regression(strategyReturns, benchmarkReturns),
    sessions: window.length - 1,
  };
}

/** First calendar day of the week (Monday), month, quarter and year containing `today`. */
export function periodStarts(today: string) {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    week: date.toISOString().slice(0, 10),
    month: `${year}-${pad(month)}-01`,
    quarter: `${year}-${pad(Math.floor((month - 1) / 3) * 3 + 1)}-01`,
    year: `${year}-01-01`,
  };
}
