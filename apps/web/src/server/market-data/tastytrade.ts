import { createHash } from "node:crypto";
import { RESOLUTIONS, type MarketBar, type MarketHistory } from "@/lib/market-data";
import {
  combineVerticalCandles,
  resolveTastytradeInstrument,
  tastytradeCandleSymbol,
} from "@/lib/tastytrade-symbols";
import { MarketDataError, type HistoryRequest, type MarketDataProvider } from "./provider";
import { credentials, number, readJson, record, result, validateBars } from "./http";

const USER_AGENT = "trade-journal/0.1";
const CHANNEL = 1;
const SNAPSHOT_END = 0x8;
const SNAPSHOT_SNIP = 0x10;
const REMOVE_EVENT = 0x2;
const CANDLE_FIELDS = [
  "eventSymbol",
  "eventFlags",
  "time",
  "open",
  "high",
  "low",
  "close",
  "volume",
];
const REST_HOSTS = new Set(["api.tastyworks.com", "api.cert.tastyworks.com"]);
const DXLINK_HOST = /\.dxfeed\.com$/i;

type Auth = {
  access: string;
  accessExp: number;
  quote?: string;
  quoteUrl?: string;
  quoteExp: number;
};
const authCache = new Map<string, Auth>();

export function resetTastytradeAuth() {
  authCache.clear();
}

const configFor = (key: string) => {
  const config = credentials(key);
  if (
    !["live", "sandbox"].includes(config.environment ?? "") ||
    !config.clientSecret ||
    !config.refreshToken
  )
    throw new MarketDataError(
      "Check your Tastytrade OAuth client secret, refresh token and environment.",
    );
  return {
    base:
      config.environment === "sandbox"
        ? "https://api.cert.tastyworks.com"
        : "https://api.tastyworks.com",
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    clientId: config.clientId?.trim() || undefined,
    cacheKey: createHash("sha256").update(key).digest("hex"),
  };
};

const headers = (access?: string): Record<string, string> => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
  ...(access ? { Authorization: `Bearer ${access}` } : {}),
});

function assertHost(url: string, allowed: (host: string) => boolean) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketDataError("Tastytrade returned an invalid URL.");
  }
  if (!allowed(parsed.host) || (parsed.protocol !== "https:" && parsed.protocol !== "wss:"))
    throw new MarketDataError("Tastytrade returned an unexpected host.");
  return parsed;
}

async function restJson(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  options: { allow404?: boolean } = {},
): Promise<unknown> {
  assertHost(url, (host) => REST_HOSTS.has(host));
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      headers: { ...headers(), ...init.headers },
    });
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    throw new MarketDataError("Market data request failed or timed out. Try again.");
  }
  if (options.allow404 && response.status === 404) return null;
  if (!response.ok)
    throw new MarketDataError(
      response.status === 401 || response.status === 403
        ? "Market data access denied. Check credentials, environment and feed permissions."
        : response.status === 429
          ? "Market data rate limit reached. Try again later."
          : `Market data request failed (${response.status}). Check the instrument and data coverage.`,
    );
  return response.json();
}

async function accessToken(
  key: string,
  signal?: AbortSignal,
): Promise<{ config: ReturnType<typeof configFor>; access: string }> {
  const config = configFor(key);
  const cached = authCache.get(config.cacheKey);
  if (cached && cached.accessExp > Date.now() + 30_000) return { config, access: cached.access };
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_secret: config.clientSecret,
  };
  if (config.clientId) body.client_id = config.clientId;
  const payload = record(
    await restJson(`${config.base}/oauth/token`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  );
  const nested = payload.data && typeof payload.data === "object" ? record(payload.data) : payload;
  const access = typeof nested.access_token === "string" ? nested.access_token.trim() : "";
  const expires = Number(nested.expires_in);
  if (!access) throw new MarketDataError("Tastytrade did not return an access token.");
  authCache.set(config.cacheKey, {
    access,
    accessExp:
      Date.now() + (Number.isFinite(expires) && expires > 0 ? expires * 1000 : 15 * 60_000),
    quoteExp: cached?.quoteExp ?? 0,
    quote: cached?.quote,
    quoteUrl: cached?.quoteUrl,
  });
  return { config, access };
}

async function quoteSession(key: string, signal?: AbortSignal) {
  const { config, access } = await accessToken(key, signal);
  const cached = authCache.get(config.cacheKey);
  if (cached?.quote && cached.quoteUrl && cached.quoteExp > Date.now() + 60_000)
    return { token: cached.quote, url: cached.quoteUrl, access };
  const payload = record(
    await readJson(`${config.base}/api-quote-tokens`, headers(access), signal, { cache: false }),
  );
  const data = record(payload.data ?? payload);
  const token = typeof data.token === "string" ? data.token.trim() : "";
  const url = typeof data["dxlink-url"] === "string" ? data["dxlink-url"].trim() : "";
  if (!token || !url) throw new MarketDataError("Tastytrade did not return a market data stream.");
  assertHost(url, (host) => DXLINK_HOST.test(host));
  authCache.set(config.cacheKey, {
    access,
    accessExp: cached?.accessExp ?? Date.now() + 14 * 60_000,
    quote: token,
    quoteUrl: url,
    quoteExp: Date.now() + 20 * 60 * 60_000,
  });
  return { token, url, access };
}

function finiteBar(row: Record<string, unknown>): MarketBar | null {
  if (typeof row.eventFlags === "number" && row.eventFlags & REMOVE_EVENT) return null;
  const bar = {
    time: number(row.time),
    open: number(row.open),
    high: number(row.high),
    low: number(row.low),
    close: number(row.close),
    volume: row.volume == null ? 0 : number(row.volume),
  };
  if (!Object.values(bar).every(Number.isFinite) || bar.volume < 0 || bar.low > bar.high)
    return null;
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close))
    return null;
  return bar;
}

function parseFeed(data: unknown, streamer: string): { bars: MarketBar[]; flags: number } {
  const bars: MarketBar[] = [];
  let flags = 0;
  const matches = (row: Record<string, unknown>) => {
    const symbol = typeof row.eventSymbol === "string" ? row.eventSymbol.replace(/\{.*$/, "") : "";
    return !/^[.$A-Z]/.test(symbol) || symbol === streamer;
  };
  const push = (row: Record<string, unknown>) => {
    if (typeof row.eventFlags === "number") flags |= row.eventFlags;
    if (!matches(row)) return;
    const bar = finiteBar(row);
    if (bar) bars.push(bar);
  };
  if (Array.isArray(data) && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
    for (const item of data) push(record(item));
    return { bars, flags };
  }
  if (
    Array.isArray(data) &&
    data[0] === "Candle" &&
    Array.isArray(data[1]) &&
    data[1].length % CANDLE_FIELDS.length === 0
  ) {
    const values = data[1] as unknown[];
    for (let i = 0; i < values.length; i += CANDLE_FIELDS.length) {
      const row = Object.fromEntries(
        CANDLE_FIELDS.map((field, index) => [field, values[i + index]]),
      );
      push(row);
    }
  }
  return { bars, flags };
}

async function readCandles(
  url: string,
  token: string,
  streamer: string,
  request: HistoryRequest,
  price: "last" | "mark" = "last",
): Promise<{ bars: MarketBar[]; truncated: boolean }> {
  const step = RESOLUTIONS[request.resolution];
  const from = Math.floor(request.from / step) * step;
  const symbol = tastytradeCandleSymbol(streamer, request.resolution, price);
  const socket = new WebSocket(url);
  const unique = new Map<number, MarketBar>();
  let truncated = false;
  let opened = false;
  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  return await new Promise<{ bars: MarketBar[]; truncated: boolean }>((resolve, reject) => {
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      try {
        if (opened) send({ type: "CHANNEL_CANCEL", channel: CHANNEL });
        socket.close();
      } catch {
        /* already closing */
      }
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(timeout);
      clearInterval(heartbeat);
      request.signal?.removeEventListener("abort", abort);
      stop();
      if (error)
        reject(
          error instanceof MarketDataError
            ? error
            : new MarketDataError("Market data request failed or timed out. Try again."),
        );
      else resolve({ bars: [...unique.values()].sort((a, b) => a.time - b.time), truncated });
    };
    const abort = () => finish(request.signal?.reason ?? new MarketDataError("Cancelled"));
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(), unique.size ? 400 : 12_000);
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(
      () => finish(new MarketDataError("Market data request failed or timed out. Try again.")),
      90_000,
    );
    socket.addEventListener("open", () => {
      opened = true;
      send({
        type: "SETUP",
        channel: 0,
        version: "0.1-DXF-JS/0.3.0",
        keepaliveTimeout: 60,
        acceptKeepaliveTimeout: 60,
      });
    });
    socket.addEventListener("message", (event) => {
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(String(event.data)));
      } catch {
        return;
      }
      if (message.type === "AUTH_STATE" && message.state === "UNAUTHORIZED")
        send({ type: "AUTH", channel: 0, token });
      else if (message.type === "AUTH_STATE" && message.state === "AUTHORIZED") {
        heartbeat = setInterval(() => send({ type: "KEEPALIVE", channel: 0 }), 30_000);
        send({
          type: "CHANNEL_REQUEST",
          channel: CHANNEL,
          service: "FEED",
          parameters: { contract: "AUTO" },
        });
      } else if (message.type === "CHANNEL_OPENED") {
        send({
          type: "FEED_SETUP",
          channel: CHANNEL,
          acceptAggregationPeriod: 0,
          acceptDataFormat: "FULL",
          acceptEventFields: { Candle: CANDLE_FIELDS },
        });
        send({
          type: "FEED_SUBSCRIPTION",
          channel: CHANNEL,
          reset: true,
          add: [{ type: "Candle", symbol, fromTime: from }],
        });
        bump();
      } else if (message.type === "FEED_DATA") {
        const parsed = parseFeed(message.data, streamer);
        if (parsed.flags & SNAPSHOT_SNIP) truncated = true;
        for (const bar of parsed.bars) unique.set(bar.time, bar);
        const oldest = [...unique.keys()].reduce((min, time) => Math.min(min, time), Infinity);
        if (parsed.flags & (SNAPSHOT_END | SNAPSHOT_SNIP) || oldest <= from) finish();
        else bump();
      } else if (message.type === "ERROR")
        finish(
          new MarketDataError(
            "Market data request failed. Check the instrument and data coverage.",
          ),
        );
    });
    socket.addEventListener("error", () =>
      finish(new MarketDataError("Market data request failed or timed out. Try again.")),
    );
    socket.addEventListener("close", () => {
      if (!settled) finish();
    });
  });
}

async function historyFor(
  request: HistoryRequest,
  key: string,
  streamer: string,
  price: "last" | "mark" = "last",
  lastFallback = true,
): Promise<{ bars: MarketBar[]; truncated: boolean; symbol: string }> {
  if (!/^[A-Z0-9./$:=_-]{1,40}$/.test(streamer))
    throw new MarketDataError(
      "Use a Tastytrade or dxFeed symbol such as AAPL, $SPX or .SPY250117C150.",
    );
  const session = await quoteSession(key, request.signal);
  let candles = await readCandles(session.url, session.token, streamer, request, price);
  if (price === "mark" && lastFallback && !candles.bars.length)
    candles = await readCandles(session.url, session.token, streamer, request, "last");
  return { ...candles, symbol: streamer };
}

function tastytradeResult(
  request: HistoryRequest,
  bars: MarketBar[],
  truncated: boolean,
  symbol: string,
  warnings: string[],
  priceKind: MarketHistory["priceKind"],
): MarketHistory {
  return {
    ...result("Tastytrade", { ...request, symbol }, validateBars(bars), truncated, warnings, "USD"),
    priceKind,
  };
}

export const tastytrade: MarketDataProvider = {
  id: "tastytrade",
  name: "Tastytrade",
  environmentKey: "TASTYTRADE_CLIENT_SECRET",
  async test(key) {
    await quoteSession(key);
  },
  async history(request, key) {
    if (request.dataset)
      throw new MarketDataError("Tastytrade uses one candle feed; leave the dataset blank.");
    const instrument = resolveTastytradeInstrument(request.symbol);
    const fallbackWarning =
      "Option contract candles were unavailable. These are underlying prices for replay only; MAE/MFE is withheld because fill prices are option premiums.";
    const coverage =
      "Tastytrade/dxFeed candles. Coverage is typically the most recent ~8,000 bars; choose a coarser resolution for longer trades.";

    if (instrument.kind === "vertical") {
      // Authenticate once so the parallel legs share cached tokens.
      await quoteSession(key, request.signal);
      const legs = await Promise.all(
        [instrument.lowStreamer, instrument.highStreamer].map(async (streamer) => {
          try {
            // Marks only: a last-print leg would be stale against the other leg's mark.
            return await historyFor(request, key, streamer, "mark", false);
          } catch (error) {
            if (error instanceof MarketDataError) return null;
            throw error;
          }
        }),
      );
      const combined =
        legs[0] && legs[1]
          ? combineVerticalCandles(
              instrument.right === "C" ? legs[0].bars : legs[1].bars,
              instrument.right === "C" ? legs[1].bars : legs[0].bars,
              instrument.width,
            )
          : [];
      if (combined.length)
        return tastytradeResult(
          request,
          combined,
          Boolean(legs[0]?.truncated || legs[1]?.truncated),
          `${instrument.lowStreamer}-${instrument.highStreamer}`,
          [
            coverage,
            "Each vertical bar is the sold contract's mark minus the bought contract's mark (mid bid/ask), not last prints. Last-trade candles leave the hedge at 0 and look like the short call alone.",
          ],
          "instrument",
        );
      const loaded = await historyFor(request, key, instrument.underlying);
      return tastytradeResult(
        request,
        loaded.bars,
        loaded.truncated,
        loaded.symbol,
        [coverage, fallbackWarning],
        "underlying",
      );
    }

    if (instrument.kind === "option") {
      let optionHistory: { bars: MarketBar[]; truncated: boolean; symbol: string } | null = null;
      try {
        optionHistory = await historyFor(request, key, instrument.streamer, "mark");
      } catch (error) {
        if (!(error instanceof MarketDataError)) throw error;
      }
      const usable = Boolean(optionHistory?.bars.length);
      if (usable && optionHistory)
        return tastytradeResult(
          request,
          optionHistory.bars,
          optionHistory.truncated,
          optionHistory.symbol,
          [coverage, "Option contract candles from Tastytrade/dxFeed."],
          "instrument",
        );
      const underlying = await historyFor(request, key, instrument.underlying);
      return tastytradeResult(
        request,
        underlying.bars,
        underlying.truncated,
        underlying.symbol,
        [coverage, fallbackWarning],
        "underlying",
      );
    }

    const loaded = await historyFor(request, key, instrument.symbol);
    return tastytradeResult(
      request,
      loaded.bars,
      loaded.truncated,
      loaded.symbol,
      [coverage],
      "instrument",
    );
  },
};
