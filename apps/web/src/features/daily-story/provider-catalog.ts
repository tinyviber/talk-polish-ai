import {
  DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  normalizeProviderBaseUrl,
  type ProviderPresetId,
} from "@kotoba/contracts";
import type { DailyCapability } from "./types";

export type ProviderId = ProviderPresetId | "custom";

export type ProviderPreset = {
  endpoint: string;
  model: string;
  responseFormat?: string;
  voice?: string;
};

export type ProviderCapability = {
  supported: boolean;
  preset?: ProviderPreset;
  note?: string;
};

export type ProviderCatalogItem = {
  id: ProviderPresetId;
  name: string;
  description: string;
  capabilities: Record<DailyCapability, ProviderCapability>;
};

export const CAPABILITY_LABELS: Record<DailyCapability, string> = {
  chat: "Chat",
  asr: "ASR",
  tts: "TTS",
};

export const PROVIDER_CATALOG: readonly ProviderCatalogItem[] = [
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    description: "适用于 OpenAI API 兼容服务。",
    capabilities: {
      chat: {
        supported: true,
        preset: { endpoint: OPENAI_COMPATIBLE_DEFAULT_BASE_URL, model: "gpt-4o-mini" },
      },
      asr: {
        supported: true,
        preset: {
          endpoint: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
          model: "whisper-1",
          responseFormat: "json",
        },
      },
      tts: {
        supported: true,
        preset: {
          endpoint: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
      },
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "适合 Chat；当前不提供语音能力。",
    capabilities: {
      chat: {
        supported: true,
        preset: { endpoint: DEEPSEEK_DEFAULT_BASE_URL, model: "deepseek-v4-flash" },
      },
      asr: { supported: false, note: "DeepSeek 当前不提供 ASR。" },
      tts: { supported: false, note: "DeepSeek 当前不提供 TTS。" },
    },
  },
  {
    id: "dashscope-compatible",
    name: "阿里百炼",
    description: "支持 Chat 与 Qwen3-ASR；TTS 暂未接入。",
    capabilities: {
      chat: {
        supported: true,
        preset: { endpoint: DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL, model: "qwen-plus" },
      },
      asr: {
        supported: true,
        preset: {
          endpoint: DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL,
          model: "qwen3-asr-flash",
          responseFormat: "json",
        },
      },
      tts: { supported: false, note: "阿里百炼的 TTS 尚未接入 Daily Story。" },
    },
  },
];

export const CUSTOM_PROVIDER: ProviderCatalogItem = {
  id: "openai-compatible",
  name: "自定义 / 旧配置",
  description: "保留当前配置，手动填写 endpoint、model 和其它字段。",
  capabilities: {
    chat: { supported: true },
    asr: { supported: true },
    tts: { supported: true },
  },
};

export function getProvider(id: ProviderId) {
  if (id === "custom") return CUSTOM_PROVIDER;
  return PROVIDER_CATALOG.find((provider) => provider.id === id) ?? CUSTOM_PROVIDER;
}

export function getProviderCapability(id: ProviderId, capability: DailyCapability) {
  return getProvider(id).capabilities[capability];
}

export function normalizeProviderEndpoint(value: string) {
  if (!value.trim()) return "";
  try {
    return normalizeProviderBaseUrl(value);
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function providerIdForEndpoint(capability: DailyCapability, endpoint: string): ProviderId {
  const normalized = normalizeProviderEndpoint(endpoint);
  if (!normalized) return "openai-compatible";
  const match = PROVIDER_CATALOG.find(
    (provider) =>
      provider.capabilities[capability].supported &&
      provider.capabilities[capability].preset &&
      normalizeProviderEndpoint(provider.capabilities[capability].preset.endpoint) === normalized,
  );
  return match?.id ?? "custom";
}
