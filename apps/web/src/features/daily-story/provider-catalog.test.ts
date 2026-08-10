import { describe, expect, test } from "vitest";
import {
  getProviderCapability,
  normalizeProviderEndpoint,
  providerIdForEndpoint,
  PROVIDER_CATALOG,
} from "./provider-catalog";

describe("Daily Story provider catalog", () => {
  test("ships the first three providers with explicit capability support", () => {
    expect(PROVIDER_CATALOG.map((provider) => provider.id)).toEqual([
      "openai-compatible",
      "deepseek",
      "dashscope-compatible",
    ]);
    expect(getProviderCapability("openai-compatible", "tts").supported).toBe(true);
    expect(getProviderCapability("deepseek", "asr").supported).toBe(false);
    expect(getProviderCapability("dashscope-compatible", "asr").supported).toBe(true);
    expect(getProviderCapability("dashscope-compatible", "tts").supported).toBe(false);
  });

  test("normalizes root and trailing-slash endpoints", () => {
    expect(normalizeProviderEndpoint(" https://api.example.com ")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeProviderEndpoint("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeProviderEndpoint("https://example.com/compatible-mode/v1///")).toBe(
      "https://example.com/compatible-mode/v1",
    );
  });

  test("recognizes legacy endpoints and falls back to custom", () => {
    expect(providerIdForEndpoint("chat", "https://api.deepseek.com")).toBe("deepseek");
    expect(providerIdForEndpoint("asr", "https://api.deepseek.com/v1")).toBe("custom");
    expect(providerIdForEndpoint("chat", "https://gateway.example.com/v1")).toBe("custom");
  });
});
