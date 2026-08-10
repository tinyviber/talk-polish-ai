import { normalizeProviderEndpoint } from "@/features/daily-story/provider-catalog";

export type SettingsOperation = {
  operationId: number;
  draftVersion: number;
};

export function hasEffectiveProviderEndpointChanged(previous: string, next: string) {
  return normalizeProviderEndpoint(previous) !== normalizeProviderEndpoint(next);
}

export function isCurrentSettingsOperation(
  current: SettingsOperation,
  captured: SettingsOperation,
) {
  return (
    current.operationId === captured.operationId && current.draftVersion === captured.draftVersion
  );
}
