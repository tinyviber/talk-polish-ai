import { describe, expect, test } from "vitest";
import {
  hasEffectiveProviderEndpointChanged,
  isCurrentSettingsOperation,
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

  test("rejects stale operations after local edits or newer operations", () => {
    const captured: SettingsOperation = { operationId: 3, draftVersion: 7 };
    expect(isCurrentSettingsOperation(captured, captured)).toBe(true);
    expect(isCurrentSettingsOperation({ operationId: 3, draftVersion: 8 }, captured)).toBe(false);
    expect(isCurrentSettingsOperation({ operationId: 4, draftVersion: 7 }, captured)).toBe(false);
  });
});
