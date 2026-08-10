import {
  getProviderCapability,
  normalizeProviderEndpoint,
  type ProviderId,
} from "@/features/daily-story/provider-catalog";
import type { DailyCapability } from "@/features/daily-story/types";

export type SettingsDraft = {
  baseUrl: string;
  apiKey: string;
  model: string;
  responseFormat: string;
  voice: string;
};

export type SettingsOperation = {
  operationId: number;
  draftVersion: number;
};

export function hasEffectiveProviderEndpointChanged(previous: string, next: string) {
  return normalizeProviderEndpoint(previous) !== normalizeProviderEndpoint(next);
}

export function applyProviderSelection(
  draft: SettingsDraft,
  capability: DailyCapability,
  currentProviderId: ProviderId,
  nextProviderId: ProviderId,
) {
  const preset = getProviderCapability(nextProviderId, capability).preset;
  if (nextProviderId === "custom") return { ...draft, apiKey: "" };
  if (!preset) return draft;
  return {
    ...draft,
    ...(currentProviderId !== nextProviderId ? { apiKey: "" } : {}),
    baseUrl: preset.endpoint,
    model: preset.model,
    ...(capability === "asr" ? { responseFormat: preset.responseFormat ?? "" } : {}),
    ...(capability === "tts" ? { voice: preset.voice ?? "" } : {}),
  };
}

export function isCurrentSettingsOperation(
  current: SettingsOperation,
  captured: SettingsOperation,
) {
  return (
    current.operationId === captured.operationId && current.draftVersion === captured.draftVersion
  );
}
