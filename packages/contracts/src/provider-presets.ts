import { z } from "zod";

/** Stable provider identities used by the first provider-preset catalog. */
export const PROVIDER_PRESET_IDS = [
  "openai-compatible",
  "deepseek",
  "dashscope-compatible",
] as const;

export const providerPresetIdSchema = z.enum(PROVIDER_PRESET_IDS);
export type ProviderPresetId = z.infer<typeof providerPresetIdSchema>;
export const dailyStoryProviderPresetIdSchema = providerPresetIdSchema;
export type DailyStoryProviderPresetId = ProviderPresetId;

export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

export type ProviderPreset = {
  id: ProviderPresetId;
  label: string;
  defaultBaseUrl: string;
};

/** Public, credential-free provider metadata. */
export const PROVIDER_PRESETS: Readonly<Record<ProviderPresetId, ProviderPreset>> = {
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    defaultBaseUrl: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
  },
  "dashscope-compatible": {
    id: "dashscope-compatible",
    label: "DashScope compatible",
    defaultBaseUrl: DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL,
  },
};

export const PROVIDER_PRESET_DEFAULT_ENDPOINTS = Object.freeze(
  Object.fromEntries(
    PROVIDER_PRESET_IDS.map((id) => [id, PROVIDER_PRESETS[id].defaultBaseUrl]),
  ) as Record<ProviderPresetId, string>,
);

/**
 * Canonicalize an OpenAI-compatible provider endpoint.
 *
 * Existing settings may contain only an origin (or a provider-specific path)
 * from before the `/v1` contract. Appending to the existing pathname keeps
 * DashScope's `/compatible-mode/v1` endpoint intact while making every valid
 * result end in `/v1`.
 */
export function normalizeProviderBaseUrl(value: string): string {
  if (typeof value !== "string") throw new TypeError("Provider base URL must be a string.");

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("Provider base URL must be an absolute URL.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Provider base URL is invalid.");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (/\/(?:chat\/completions|audio\/(?:transcriptions|speech))$/i.test(pathname)) {
    throw new TypeError("Provider base URL must not include an operation path.");
  }
  url.pathname = pathname === "" ? "/v1" : pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}

export function isDashScopeCompatibleBaseUrl(value: string) {
  try {
    const url = new URL(normalizeProviderBaseUrl(value));
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const isDashScopeHost =
      hostname === "dashscope.aliyuncs.com" ||
      hostname === "dashscope-intl.aliyuncs.com" ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(hostname);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      isDashScopeHost &&
      url.pathname === "/compatible-mode/v1"
    );
  } catch {
    return false;
  }
}

function canonicalEndpointIdentity(value: string) {
  try {
    const url = new URL(normalizeProviderBaseUrl(value));
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** Infer a known preset without accepting provider credentials or other config. */
export function identifyProviderPreset(value: string): ProviderPresetId | undefined {
  const identity = canonicalEndpointIdentity(value);
  if (identity === canonicalEndpointIdentity(OPENAI_COMPATIBLE_DEFAULT_BASE_URL)) {
    return "openai-compatible";
  }
  if (identity === canonicalEndpointIdentity(DEEPSEEK_DEFAULT_BASE_URL)) return "deepseek";
  if (isDashScopeCompatibleBaseUrl(value)) return "dashscope-compatible";
  return undefined;
}

/** Alias for callers that use the catalog's verb rather than its identity. */
export const recognizeProviderPreset = identifyProviderPreset;
