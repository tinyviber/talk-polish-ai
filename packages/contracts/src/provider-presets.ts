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
export const DASHSCOPE_DIRECT_CONNECT_SOURCES = [
  "https://dashscope.aliyuncs.com",
  "https://dashscope-intl.aliyuncs.com",
] as const;
export const DASHSCOPE_FUN_ASR_HTTP_MODELS = [
  "fun-asr-realtime",
  "fun-asr-realtime-2026-02-28",
] as const;
export const DASHSCOPE_FUN_ASR_HTTP_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
] as const;
export const DASHSCOPE_FUN_ASR_NATIVE_PATH =
  "/api/v1/services/aigc/multimodal-generation/generation";

export type DashScopeFunAsrBrowserDirectResolution =
  | {
      supported: true;
      endpoint: URL;
    }
  | {
      supported: false;
      code: "unsupported-model" | "unsupported-endpoint" | "workspace-no-cors";
      message: string;
    };

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
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      isDashScopeHostname(url.hostname) &&
      url.pathname === "/compatible-mode/v1"
    );
  } catch {
    return false;
  }
}

/** DashScope base URLs used by both compatible-mode and native HTTP APIs. */
export function isDashScopeBaseUrl(value: string) {
  try {
    const url = new URL(normalizeProviderBaseUrl(value));
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      isDashScopeHostname(url.hostname) &&
      (url.pathname === "/compatible-mode/v1" || url.pathname === "/api/v1")
    );
  } catch {
    return false;
  }
}

function isDashScopeHostname(value: string) {
  const hostname = value.toLowerCase().replace(/\.+$/, "");
  return isDashScopeBrowserDirectHostname(hostname) || isDashScopeWorkspaceHostname(hostname);
}

function isDashScopeBrowserDirectHostname(value: string) {
  return value === "dashscope.aliyuncs.com" || value === "dashscope-intl.aliyuncs.com";
}

function isDashScopeWorkspaceHostname(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(value);
}

export function isDashScopeFunAsrHttpModel(value: string) {
  return (DASHSCOPE_FUN_ASR_HTTP_MODELS as readonly string[]).includes(value);
}

export function getDashScopeFunAsrNativeEndpoint(
  provider: Pick<{ baseUrl: string; model: string }, "baseUrl" | "model">,
) {
  if (!isDashScopeFunAsrHttpModel(provider.model)) return undefined;
  try {
    const url = new URL(normalizeProviderBaseUrl(provider.baseUrl));
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      !isDashScopeHostname(url.hostname) ||
      (url.pathname !== "/compatible-mode/v1" && url.pathname !== "/api/v1")
    ) {
      return undefined;
    }
    return new URL(DASHSCOPE_FUN_ASR_NATIVE_PATH, `${url.origin}/`);
  } catch {
    return undefined;
  }
}

export function resolveDashScopeFunAsrBrowserDirect(
  provider: Pick<{ baseUrl: string; model: string }, "baseUrl" | "model">,
): DashScopeFunAsrBrowserDirectResolution {
  if (!isDashScopeFunAsrHttpModel(provider.model)) {
    return unsupportedBrowserDirectResolution("unsupported-model");
  }
  try {
    const url = new URL(normalizeProviderBaseUrl(provider.baseUrl));
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      (url.pathname !== "/compatible-mode/v1" && url.pathname !== "/api/v1")
    ) {
      return unsupportedBrowserDirectResolution();
    }
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (isDashScopeBrowserDirectHostname(hostname)) {
      return {
        supported: true,
        endpoint: new URL(DASHSCOPE_FUN_ASR_NATIVE_PATH, `${url.origin}/`),
      };
    }
    if (isDashScopeWorkspaceHostname(hostname)) {
      return {
        supported: false,
        code: "workspace-no-cors",
        message:
          "该 workspace DashScope endpoint 不支持浏览器 CORS，请关闭直连使用 proxy，或改用公共 DashScope endpoint。",
      };
    }
    return unsupportedBrowserDirectResolution();
  } catch {
    return unsupportedBrowserDirectResolution();
  }
}

function unsupportedBrowserDirectResolution(
  code: "unsupported-model" | "unsupported-endpoint" = "unsupported-endpoint",
): DashScopeFunAsrBrowserDirectResolution {
  return {
    supported: false,
    code,
    message:
      "浏览器直连 ASR 仅支持公共 DashScope HTTPS endpoint（dashscope.aliyuncs.com 或 dashscope-intl.aliyuncs.com）与 Fun-ASR HTTP model；请关闭直连使用 proxy，或改用公共 DashScope endpoint。",
  };
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
