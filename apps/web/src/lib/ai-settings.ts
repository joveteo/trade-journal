export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4.1-mini",
};

export const AI_PROVIDER_NAMES: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Default cloud OpenAI root. A matching saved URL is treated as unset. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Placeholder shown for OpenAI-compatible local servers such as LM Studio. */
export const OPENAI_COMPATIBLE_BASE_URL_PLACEHOLDER = "http://127.0.0.1:1234/v1";

/** Dummy key accepted by local OpenAI-compatible servers that require a Bearer token. */
export const OPENAI_LOCAL_API_KEY = "lm-studio";

export interface AiConnection {
  configured: boolean;
  source: "environment" | "saved" | null;
  model: string;
  baseUrl: string | null;
  baseUrlSource: "environment" | "saved" | null;
}

export interface AiSettingsPayload {
  aiProvider: AiProvider;
  aiConfigured: boolean;
  aiModel: string;
  aiConnections: Record<AiProvider, AiConnection>;
}

export const isAiProvider = (value: unknown): value is AiProvider =>
  value === "anthropic" || value === "openai";

const openaiBaseUrlFromParsed = (parsed: URL): string | null => {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (!parsed.hostname) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = !path || path === "/" ? "/v1" : path;
  return parsed.toString().replace(/\/+$/, "");
};

/** Normalized custom base URL, or null when empty/default. Invalid input is null. */
export const parseOpenAiBaseUrl = (value: string): string | null => {
  const normalized = normalizeOpenAiBaseUrl(value);
  return !normalized || normalized === OPENAI_DEFAULT_BASE_URL ? null : normalized;
};

/** True for empty (clear), the cloud default, or a valid http(s) API root. */
export const isValidOpenAiBaseUrl = (value: string): boolean =>
  !value.trim() || normalizeOpenAiBaseUrl(value) !== null;

const normalizeOpenAiBaseUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) return null;
  try {
    return openaiBaseUrlFromParsed(new URL(trimmed));
  } catch {
    return null;
  }
};
