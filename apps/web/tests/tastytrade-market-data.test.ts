import { createMarketTransport, marketTransport } from "../src/server/market-data/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tastytrade, resetTastytradeAuth } from "../src/server/market-data/tastytrade";

const start = Date.parse("2026-01-02T10:00:00Z");
const key = JSON.stringify({
  clientSecret: "c".repeat(24),
  refreshToken: "r".repeat(24),
  environment: "live",
});
const request = {
  symbol: "AAPL",
  resolution: "1m" as const,
  from: start,
  to: start + 180_000,
};

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static candles: Record<string, Record<string, unknown>[]> = {};
  readyState = 0;
  listeners: Record<string, ((event?: { data?: string }) => void)[]> = {};
  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }
  addEventListener(type: string, listener: (event?: { data?: string }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(raw: string) {
    const message = JSON.parse(raw) as { type: string; add?: { symbol: string }[] };
    queueMicrotask(() => this.reply(message));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  private emit(type: string, data?: unknown) {
    for (const listener of this.listeners[type] ?? [])
      listener(type === "message" ? { data: JSON.stringify(data) } : {});
  }
  private reply(message: { type: string; add?: { symbol: string }[] }) {
    if (message.type === "SETUP")
      this.emit("message", { type: "AUTH_STATE", state: "UNAUTHORIZED" });
    else if (message.type === "AUTH")
      this.emit("message", { type: "AUTH_STATE", state: "AUTHORIZED" });
    else if (message.type === "CHANNEL_REQUEST")
      this.emit("message", { type: "CHANNEL_OPENED", channel: 1 });
    else if (message.type === "FEED_SUBSCRIPTION") {
      const candleSymbol = message.add?.[0]?.symbol ?? "";
      const streamer = candleSymbol.replace(/\{.*$/, "");
      const rows = FakeWebSocket.candles[streamer] ?? [];
      this.emit("message", {
        type: "FEED_DATA",
        channel: 1,
        data: [
          ...rows,
          {
            eventSymbol: candleSymbol,
            eventFlags: 8,
            time: Number.NaN,
            open: Number.NaN,
            high: Number.NaN,
            low: Number.NaN,
            close: Number.NaN,
            volume: Number.NaN,
          },
        ],
      });
    }
  }
}

const bars = (prices: number[]) =>
  prices.map((price, minute) => ({
    eventSymbol: "fixture",
    eventFlags: 0,
    time: start + minute * 60_000,
    open: price,
    high: price + 2,
    low: price - 2,
    close: price,
    volume: 1,
  }));

beforeEach(() => {
  resetTastytradeAuth();
  FakeWebSocket.candles = {};
  Object.assign(marketTransport, createMarketTransport({ minIntervalMs: 0 }));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const href = String(url);
      if (href.endsWith("/oauth/token"))
        return Response.json({ access_token: "access-token", expires_in: 900 });
      if (href.endsWith("/api-quote-tokens"))
        return Response.json({
          data: { token: "dx-token", "dxlink-url": "wss://tasty-openapi-ws.dxfeed.com/realtime" },
        });
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  marketTransport.clear();
  vi.unstubAllGlobals();
  resetTastytradeAuth();
});

describe("Tastytrade candles", () => {
  it("loads stock history through dxLink after exchanging an OAuth refresh token", async () => {
    FakeWebSocket.candles.AAPL = bars([100, 101, 102]);
    const history = await tastytrade.history(request, key);
    expect(history.symbol).toBe("AAPL");
    expect(history.priceKind).toBe("instrument");
    expect(history.quoteCurrency).toBe("USD");
    expect(history.bars.map((bar) => bar.close)).toEqual([100, 101, 102]);
    expect(JSON.stringify(history)).not.toContain("access-token");
    expect(JSON.stringify(history)).not.toContain("r".repeat(24));
  });

  it("falls back to the cash index when option contract candles are empty", async () => {
    FakeWebSocket.candles.$SPX = bars([6650, 6652, 6654]);
    const history = await tastytrade.history({ ...request, symbol: "SPXW 17APR26 6865 C" }, key);
    expect(history.symbol).toBe("$SPX");
    expect(history.priceKind).toBe("underlying");
    expect(history.bars).toHaveLength(3);
    expect(history.warnings.join()).toContain("underlying");
  });

  it("keeps option premiums when contract candles exist", async () => {
    FakeWebSocket.candles[".AAPL250117C150"] = bars([2.4, 2.5, 2.6]);
    const history = await tastytrade.history({ ...request, symbol: "AAPL 17JAN25 150 C" }, key);
    expect(history.symbol).toBe(".AAPL250117C150");
    expect(history.priceKind).toBe("instrument");
    expect(history.bars.map((bar) => bar.close)).toEqual([2.4, 2.5, 2.6]);
  });

  it("combines both vertical legs into a net-premium series", async () => {
    FakeWebSocket.candles[".SPXW251113C6800"] = bars([2.5, 2.6, 2.4]);
    FakeWebSocket.candles[".SPXW251113C6815"] = bars([1.8, 1.9, 1.7]);
    const history = await tastytrade.history(
      { ...request, symbol: "SPXW 13NOV25 6800/6815 C VERTICAL" },
      key,
    );
    expect(history.priceKind).toBe("instrument");
    expect(history.symbol).toBe(".SPXW251113C6800-.SPXW251113C6815");
    expect(history.bars.map((bar) => Number(bar.close.toFixed(4)))).toEqual([0.7, 0.7, 0.7]);
    expect(history.warnings.join()).toContain("vertical");
  });

  it("falls back to the cash index when a vertical leg is missing", async () => {
    FakeWebSocket.candles[".SPXW251113C6800"] = bars([2.5, 2.6, 2.4]);
    FakeWebSocket.candles.$SPX = bars([6800, 6805, 6810]);
    const history = await tastytrade.history(
      { ...request, symbol: "SPXW 13NOV25 6800/6815 C VERTICAL" },
      key,
    );
    expect(history.symbol).toBe("$SPX");
    expect(history.priceKind).toBe("underlying");
  });
});
