import { describe, expect, test } from "bun:test";
import {
  DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  PROVIDER_PRESETS,
  isDashScopeBaseUrl,
  identifyProviderPreset,
  normalizeProviderBaseUrl,
  providerPresetIdSchema,
} from "./provider-presets";

describe("provider preset catalog", () => {
  test("publishes credential-free defaults with canonical /v1 suffixes", () => {
    expect(OPENAI_COMPATIBLE_DEFAULT_BASE_URL).toBe("https://api.openai.com/v1");
    expect(DEEPSEEK_DEFAULT_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(
      Object.values(PROVIDER_PRESETS).every((preset) => preset.defaultBaseUrl.endsWith("/v1")),
    ).toBe(true);
    expect(providerPresetIdSchema.safeParse("deepseek").success).toBe(true);
  });

  test("safely adds /v1 to legacy roots and paths", () => {
    expect(normalizeProviderBaseUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeProviderBaseUrl("https://provider.example.com/custom/")).toBe(
      "https://provider.example.com/custom/v1",
    );
  });

  test("does not duplicate DashScope compatible-mode/v1", () => {
    const endpoint = "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    expect(normalizeProviderBaseUrl(endpoint)).toBe(endpoint);
    expect(normalizeProviderBaseUrl(endpoint + "/")).toBe(endpoint);
    expect(normalizeProviderBaseUrl(endpoint.replace(/\/v1$/, ""))).toBe(endpoint);
  });

  test("recognizes the native DashScope API base path", () => {
    expect(
      isDashScopeBaseUrl("https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/api/v1"),
    ).toBe(true);
    expect(isDashScopeBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(true);
    expect(isDashScopeBaseUrl("https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/v1")).toBe(
      false,
    );
  });

  test("recognizes canonical provider endpoints and leaves other paths custom", () => {
    expect(identifyProviderPreset("https://api.openai.com")).toBe("openai-compatible");
    expect(identifyProviderPreset("https://api.openai.com/custom/v1")).toBeUndefined();
    expect(identifyProviderPreset("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(identifyProviderPreset("https://api.deepseek.com/custom/v1")).toBeUndefined();
    expect(identifyProviderPreset("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(
      "dashscope-compatible",
    );
    expect(
      identifyProviderPreset(
        "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode",
      ),
    ).toBe("dashscope-compatible");
    expect(
      identifyProviderPreset("https://workspace.cn-shanghai.maas.aliyuncs.com/compatible-mode/v1"),
    ).toBeUndefined();
    expect(identifyProviderPreset("https://provider.example.com/v1")).toBeUndefined();
  });

  test("rejects operation URLs instead of appending a second version suffix", () => {
    expect(() => normalizeProviderBaseUrl("https://api.example.com/v1/chat/completions")).toThrow();
    expect(() => normalizeProviderBaseUrl("https://api.example.com/v1/audio/speech")).toThrow();
  });
});
