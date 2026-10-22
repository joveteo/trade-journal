import { bad, handler, ok, requireValue } from "@/server/api";
import {
  connectionKey,
  connections,
  defaultProvider,
  providerFor,
  saveConnection,
  saveDefaultProvider,
  validateCredentials,
} from "@/server/market-data/connections";
import { MarketDataError } from "@/server/market-data/provider";

import { providerInfo } from "@/lib/market-providers";

const state = () => {
  const list = connections();
  return { connections: list, defaultProvider: defaultProvider(list) };
};

export const GET = handler(() => ok(state()));

export const POST = handler(async (request: Request) => {
  const body = await request.json();
  requireValue(body && typeof body.provider === "string", "Choose a market data provider.");
  requireValue(
    ["save", "remove", "test", "enable", "default"].includes(body.action),
    "Choose a valid connection action.",
  );
  try {
    if (body.action === "default") {
      // An empty provider clears the default so each trade asks again.
      saveDefaultProvider(body.provider || null);
      return ok(state());
    }
    const provider = providerFor(body.provider);
    const info = providerInfo(provider.id)!;
    if (body.action === "save") {
      requireValue(info.mode === "credentials", "This source does not use API keys.");
      saveConnection(
        provider.id,
        validateCredentials(provider.id, body.credentials ?? { apiKey: body.apiKey }),
      );
    } else if (body.action === "enable") {
      requireValue(
        info.mode === "public",
        "Only public sources can be enabled without credentials.",
      );
      saveConnection(provider.id, "enabled");
    } else if (body.action === "remove") saveConnection(provider.id, null);
    else await provider.test(connectionKey(provider.id));
    return ok({ ...state(), tested: body.action === "test" });
  } catch (error) {
    if (error instanceof MarketDataError) return bad(error.message, 400);
    throw error;
  }
});
