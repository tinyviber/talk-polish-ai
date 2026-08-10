import { describe, expect, test } from "vitest";
import {
  applyProviderSelection,
  hasEffectiveProviderEndpointChanged,
  isCurrentSettingsOperation,
  type SettingsDraft,
  type SettingsOperation,
} from "./settings-logic";

describe("Daily Story settings logic", () => {
  test("treats equivalent endpoint spellings as one provider endpoint", () => {
    expect(
      hasEffectiveProviderEndpointChanged(
        "https://api.example.com",
        " https://api.example.com/v1/// ",
      ),
    ).toBe(false);
    expect(
      hasEffectiveProviderEndpointChanged(
        "https://example.com/compatible-mode/v1",
        "https://example.com/compatible-mode/v1/",
      ),
    ).toBe(false);
  });

  test("detects provider endpoint identity changes", () => {
    expect(
      hasEffectiveProviderEndpointChanged(
        "https://api.example.com/v1",
        "https://other.example.com",
      ),
    ).toBe(true);
    expect(
      hasEffectiveProviderEndpointChanged("https://api.example.com/v1", "not-an-endpoint"),
    ).toBe(true);
  });

  test("clears the API key when switching from a preset provider to custom", () => {
    const draft: SettingsDraft = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "preset-key",
      model: "custom-model",
      responseFormat: "json",
      voice: "custom-voice",
    };

    expect(applyProviderSelection(draft, "chat", "openai-compatible", "custom")).toEqual({
      ...draft,
      apiKey: "",
    });
  });

  test("keeps custom draft fields unchanged when selecting custom again", () => {
    const draft: SettingsDraft = {
      baseUrl: "https://custom.example.com/v1",
      apiKey: "stale-key",
      model: "custom-model",
      responseFormat: "json",
      voice: "custom-voice",
    };

    expect(applyProviderSelection(draft, "tts", "custom", "custom")).toEqual({
      ...draft,
      apiKey: "",
    });
  });

  test("rejects stale operations after local edits or newer operations", () => {
    const captured: SettingsOperation = { operationId: 3, draftVersion: 7 };
    expect(isCurrentSettingsOperation(captured, captured)).toBe(true);
    expect(isCurrentSettingsOperation({ operationId: 3, draftVersion: 8 }, captured)).toBe(false);
    expect(isCurrentSettingsOperation({ operationId: 4, draftVersion: 7 }, captured)).toBe(false);
  });
});
