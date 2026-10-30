"use client";

import dynamic from "next/dynamic";
import { useMemo, useSyncExternalStore } from "react";
import {
  benchmarkWindow,
  MIN_RETURN_SAMPLES,
  periodStarts,
  type BenchmarkWindow,
} from "@luxalgo/journal-core";
import {
  BENCHMARK_SYMBOLS,
  isBenchmarkSymbol,
  type BenchmarkPayload,
  type BenchmarkSymbol,
} from "@/lib/benchmark";
import { useApi } from "@/lib/use-api";
import { cn, fmtNumber, fmtPercent, pnlClass } from "@/lib/utils";
import { Button } from "./ui/button";
import { CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { HelpHint } from "./ui/tooltip";

const BenchmarkChart = dynamic(() =>
  import("./charts/benchmark-chart").then((module) => module.BenchmarkChart),
);

const SYMBOL_KEY = "journal-benchmark-symbol";
const listeners = new Set<() => void>();
const readSymbol = (): BenchmarkSymbol => {
  const saved = localStorage.getItem(SYMBOL_KEY);
  return isBenchmarkSymbol(saved) ? saved : "SPY";
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

/** One benchmark choice shared by every benchmark card in this browser. */
export function useBenchmarkSymbol() {
  const symbol = useSyncExternalStore(subscribe, readSymbol, () => "SPY" as const);
  const setSymbol = (next: BenchmarkSymbol) => {
    localStorage.setItem(SYMBOL_KEY, next);
    listeners.forEach((notify) => notify());
  };
  return [symbol, setSymbol] as const;
}

/** Date filters are dropped: windows are sliced client-side from full history. */
function useBenchmark(query: string, symbol: BenchmarkSymbol) {
  const params = new URLSearchParams(query);
  params.delete("from");
  params.delete("to");
  params.set("benchmark", symbol);
  return useApi<BenchmarkPayload>(`/api/benchmark?${params}`);
}

function SymbolToggle({
  symbol,
  onChange,
}: {
  symbol: BenchmarkSymbol;
  onChange: (symbol: BenchmarkSymbol) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Benchmark" className="flex rounded-md border p-0.5">
      {BENCHMARK_SYMBOLS.map((option) => (
        <Button
          key={option}
          role="radio"
          aria-checked={symbol === option}
          size="sm"
          variant={symbol === option ? "secondary" : "ghost"}
          className="h-6 px-2 text-xs"
          onClick={() => onChange(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

const basisLabel = (data: BenchmarkPayload) =>
  `${data.symbol} ${data.basis === "total" ? "total return, dividends reinvested" : "price return"} · ${data.providerName}`;

function BenchmarkStatus({
  loading,
  error,
  height,
}: {
  loading: boolean;
  error: string | null;
  height: number;
}) {
  if (loading) return <Skeleton style={{ height }} className="w-full" />;
  return (
    <div
      style={{ height }}
      className="flex flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground"
    >
      <p role="alert">{error ?? "Not enough sessions to compare yet."}</p>
      {error?.includes("Settings") && (
        <a className="underline" href="/settings#market-data">
          Open market data settings
        </a>
      )}
    </div>
  );
}

const signedPercent = (value: number | null) =>
  value === null ? "–" : `${value > 0 ? "+" : ""}${fmtPercent(value, 2)}`;

function Stat({ label, value, signed }: { label: string; value: string; signed?: number }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className={cn("tnum text-sm font-semibold", signed !== undefined && pnlClass(signed))}>
        {value}
      </div>
    </div>
  );
}

export function BenchmarkCard({
  query,
  from,
  to,
}: {
  query: string;
  from: string | null;
  to: string | null;
}) {
  const [symbol, setSymbol] = useBenchmarkSymbol();
  const { data, loading, error } = useBenchmark(query, symbol);
  const comparison = useMemo(
    () =>
      data
        ? benchmarkWindow(data.sessions, data.initialBalance, {
            from: from ?? data.firstTradeDate ?? undefined,
            to: to ?? undefined,
          })
        : null,
    [data, from, to],
  );
  return (
    <>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Equity vs {symbol} benchmark, and drawdown</CardTitle>
        <div className="flex items-center gap-2">
          <SymbolToggle symbol={symbol} onChange={setSymbol} />
          <HelpHint heading="Equity vs benchmark">
            Your realized net P&L per US session against buying {symbol} with the same account
            equity at the prior session&apos;s close. Equity is the initial balance plus P&L
            realized before the period. P&L closed after 16:00 ET counts on the next session. The
            red area is the strategy&apos;s fall from its running peak. Beta and correlation use
            daily returns and need {MIN_RETURN_SAMPLES} sessions.
          </HelpHint>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data && comparison ? (
          <>
            <BenchmarkChart points={comparison.points} symbol={symbol} currency={data.currency} />
            <BenchmarkStats comparison={comparison} symbol={symbol} />
            <p className="text-[11px] text-muted-foreground">
              {basisLabel(data)} · from {comparison.anchorDate} close on{" "}
              {fmtNumber(comparison.capital, 0)} {data.currency} equity · {comparison.sessions}{" "}
              sessions
              {data.warnings.length ? ` · ${data.warnings.join(" ")}` : ""}
            </p>
          </>
        ) : (
          <BenchmarkStatus loading={loading} error={error} height={300} />
        )}
      </CardContent>
    </>
  );
}

function BenchmarkStats({ comparison, symbol }: { comparison: BenchmarkWindow; symbol: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-t pt-3 sm:grid-cols-6">
      <Stat
        label="Strategy"
        value={signedPercent(comparison.strategyReturn)}
        signed={comparison.strategyReturn}
      />
      <Stat
        label={symbol}
        value={signedPercent(comparison.benchmarkReturn)}
        signed={comparison.benchmarkReturn}
      />
      <Stat
        label="Excess"
        value={signedPercent(comparison.excessReturn)}
        signed={comparison.excessReturn}
      />
      <Stat
        label="Max DD vs ETF"
        value={`${fmtPercent(comparison.strategyMaxDrawdownPct)} / ${fmtPercent(comparison.benchmarkMaxDrawdownPct)}`}
      />
      <Stat label="Beta" value={comparison.beta === null ? "–" : comparison.beta.toFixed(2)} />
      <Stat
        label="Correlation"
        value={comparison.correlation === null ? "–" : comparison.correlation.toFixed(2)}
      />
    </div>
  );
}

const PERIODS = [
  { key: "week", label: "Week to date" },
  { key: "month", label: "Month to date" },
  { key: "quarter", label: "Quarter to date" },
  { key: "year", label: "Year to date" },
] as const;

/** Week, month, quarter and year to date against the benchmark, ignoring the date filter. */
export function BenchmarkPeriodsCard({ query }: { query: string }) {
  const [symbol, setSymbol] = useBenchmarkSymbol();
  const { data, loading, error } = useBenchmark(query, symbol);
  const windows = useMemo(() => {
    if (!data) return null;
    const starts = periodStarts(data.today);
    return PERIODS.map((period) => ({
      ...period,
      comparison: benchmarkWindow(data.sessions, data.initialBalance, { from: starts[period.key] }),
    }));
  }, [data]);
  return (
    <>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Period to date vs {symbol}</CardTitle>
        <div className="flex items-center gap-2">
          <SymbolToggle symbol={symbol} onChange={setSymbol} />
          <HelpHint heading="Period to date vs benchmark">
            Each chart starts at the last session close before the week, month, quarter or year
            began, on the account equity at that close. The dashboard date range does not apply;
            account and trade filters do.
          </HelpHint>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {data && windows ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {windows.map(({ key, label, comparison }) => (
                <section key={key} aria-label={label} className="min-w-0">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                    {comparison && (
                      <span className="tnum text-[11px] text-muted-foreground">
                        <span className={pnlClass(comparison.strategyReturn)}>
                          {signedPercent(comparison.strategyReturn)}
                        </span>{" "}
                        vs {signedPercent(comparison.benchmarkReturn)}
                      </span>
                    )}
                  </div>
                  {comparison ? (
                    <BenchmarkChart
                      points={comparison.points}
                      symbol={symbol}
                      currency={data.currency}
                      height={200}
                      compact
                    />
                  ) : (
                    <BenchmarkStatus loading={false} error={null} height={200} />
                  )}
                </section>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {basisLabel(data)} · through the {data.sessions.at(-1)?.date} close
            </p>
          </>
        ) : (
          <BenchmarkStatus loading={loading} error={error} height={220} />
        )}
      </CardContent>
    </>
  );
}
