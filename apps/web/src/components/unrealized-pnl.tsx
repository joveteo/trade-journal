"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketConnectionsState } from "@/lib/market-data";
import { providerInfo } from "@/lib/market-providers";
import type { UnrealizedSummary } from "@/lib/unrealized";
import { useApi } from "@/lib/use-api";
import { Pnl } from "./pnl";
import { Button } from "./ui/button";
import { CardContent } from "./ui/card";
import { OptionSelect } from "./ui/option-select";

const PROVIDER_KEY = "journal-unrealized-provider";

/**
 * Unrealised P&L of the filtered open positions. Prices are requested only when
 * the user selects Refresh prices, using the provider's allowance.
 */
export function UnrealizedPnl({ query, openPositions }: { query: string; openPositions: number }) {
  const { data } = useApi<MarketConnectionsState>(
    openPositions > 0 ? "/api/market-data/connections" : null,
  );
  const available = data?.connections.filter((item) => item.configured) ?? [];
  // The card's last-used source wins; otherwise start from the Settings default.
  const [chosenProvider, setProvider] = useState<string | null>(null);
  // A remembered source that was since disconnected falls back to the default.
  const provider =
    chosenProvider && (!data || available.some((item) => item.id === chosenProvider))
      ? chosenProvider
      : (data?.defaultProvider ?? "");
  const [dataset, setDataset] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UnrealizedSummary | null>(null);
  const controller = useRef<AbortController | null>(null);
  const info = providerInfo(provider);

  useEffect(() => {
    const saved = localStorage.getItem(PROVIDER_KEY);
    if (saved) {
      const [id, set = ""] = saved.split("|");
      if (id) setProvider(id);
      setDataset(set);
    }
    return () => controller.current?.abort();
  }, []);

  const refresh = async () => {
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    localStorage.setItem(PROVIDER_KEY, `${provider}|${dataset}`);
    try {
      const response = await fetch(`/api/unrealized?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, dataset: dataset || undefined }),
        signal: request.signal,
      });
      const body = (await response.json()) as UnrealizedSummary & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load prices.");
      setResult(body);
    } catch (cause) {
      if (!request.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not load prices.");
    } finally {
      setBusy(false);
    }
  };

  if (openPositions === 0)
    return (
      <CardContent>
        <div className="text-xl font-semibold tnum">–</div>
        <div className="mt-1 text-xs text-muted-foreground">Flat — no open positions</div>
      </CardContent>
    );

  const issues = result?.positions.filter((mark) => mark.issue) ?? [];
  const oldest = result?.positions.reduce<number | null>(
    (min, mark) =>
      mark.unrealizedPnl !== null && mark.priceTime !== null
        ? Math.min(min ?? mark.priceTime, mark.priceTime)
        : min,
    null,
  );
  const ready =
    available.some((item) => item.id === provider) && !(info?.datasets && !dataset) && !busy;

  return (
    <CardContent className="space-y-2">
      <div>
        {result?.total != null ? (
          <Pnl
            value={result.total}
            currency={result.currency ?? undefined}
            className="text-xl font-semibold"
          />
        ) : (
          <div className="text-xl font-semibold tnum">–</div>
        )}
        <div className="mt-1 text-xs text-muted-foreground">
          {result
            ? `${result.priced} of ${result.positions.length} positions priced${
                oldest != null
                  ? ` · as of ${new Date(oldest).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}`
                  : ""
              }${result.priced > 0 && result.total === null ? " · mixed currencies, filter one account" : ""}`
            : `${openPositions} open position${openPositions === 1 ? "" : "s"} · prices not loaded`}
        </div>
      </div>
      {data && available.length === 0 ? (
        <a className="text-xs underline" href="/settings#market-data">
          Connect a market data provider in Settings
        </a>
      ) : (
        <div className="flex max-w-md flex-wrap items-center gap-1.5">
          <OptionSelect
            aria-label="Unrealised P&L price source"
            className="h-7 w-auto min-w-0 flex-1 text-xs"
            value={provider}
            disabled={busy}
            onValueChange={(value) => {
              setProvider(value);
              setDataset("");
            }}
          >
            <option value="" disabled>
              Price source
            </option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </OptionSelect>
          {info?.datasets && (
            <OptionSelect
              aria-label="Unrealised P&L dataset"
              className="h-7 w-auto min-w-0 flex-1 text-xs"
              value={dataset}
              disabled={busy}
              onValueChange={setDataset}
            >
              {info.datasets.map((item) => (
                <option key={item.value} value={item.value} disabled={!item.value}>
                  {item.label}
                </option>
              ))}
            </OptionSelect>
          )}
          {busy ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => controller.current?.abort()}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!ready}
              aria-label="Refresh prices"
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {issues.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{issues.length} not priced</summary>
          <ul className="mt-1 space-y-0.5">
            {issues.slice(0, 5).map((mark) => (
              <li key={mark.key}>
                <span className="font-medium text-foreground">{mark.symbol}</span>: {mark.issue}
              </li>
            ))}
          </ul>
        </details>
      )}
    </CardContent>
  );
}
