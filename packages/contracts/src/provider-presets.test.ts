import { describe, expect, test } from "bun:test";
import {
  DASHSCOPE_COMPATIBLE_DEFAULT_BASE_URL,
  DASHSCOPE_DIRECT_CONNECT_SOURCES,
  DASHSCOPE_FUN_ASR_NATIVE_PATH,
  DEEPSEEK_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  PROVIDER_PRESETS,
  getDashScopeFunAsrNativeEndpoint,
  isDashScopeBaseUrl,
  identifyProviderPreset,
  normalizeProviderBaseUrl,
  providerPresetIdSchema,
  resolveDashScopeFunAsrBrowserDirect,
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
    expect(DASHSCOPE_DIRECT_CONNECT_SOURCES).toEqual([
      "https://dashscope.aliyuncs.com",
      "https://dashscope-intl.aliyuncs.com",
    ]);
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

  test("keeps server-side native Fun-ASR mapping for both public and workspace DashScope hosts", () => {
    expect(
      getDashScopeFunAsrNativeEndpoint({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "fun-asr-realtime",
      })?.toString(),
    ).toBe(`https://dashscope.aliyuncs.com${DASHSCOPE_FUN_ASR_NATIVE_PATH}`);
    expect(
      getDashScopeFunAsrNativeEndpoint({
        baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/api/v1",
        model: "fun-asr-realtime-2026-02-28",
      })?.toString(),
    ).toBe(
      `https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com${DASHSCOPE_FUN_ASR_NATIVE_PATH}`,
    );

    for (const input of [
      {
        baseUrl: "https://api.example.com/v1",
        model: "fun-asr-realtime",
      },
      {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
      },
      {
        baseUrl: "https://workspace.cn-shanghai.maas.aliyuncs.com/compatible-mode/v1",
        model: "fun-asr-realtime",
      },
      {
        baseUrl: "http://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "fun-asr-realtime",
      },
      {
        baseUrl: "https://dashscope.aliyuncs.com/v1",
        model: "fun-asr-realtime",
      },
    ]) {
      expect(getDashScopeFunAsrNativeEndpoint(input)).toBeUndefined();
    }
  });

  test("allows browser direct only on the fixed public DashScope origins", () => {
    const publicBeijing = resolveDashScopeFunAsrBrowserDirect({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "fun-asr-realtime",
    });
    expect(publicBeijing.supported).toBe(true);
    expect(publicBeijing.supported && publicBeijing.endpoint.toString()).toBe(
      `https://dashscope.aliyuncs.com${DASHSCOPE_FUN_ASR_NATIVE_PATH}`,
    );

    const publicIntl = resolveDashScopeFunAsrBrowserDirect({
      baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
      model: "fun-asr-realtime-2026-02-28",
    });
    expect(publicIntl.supported).toBe(true);
    expect(publicIntl.supported && publicIntl.endpoint.toString()).toBe(
      `https://dashscope-intl.aliyuncs.com${DASHSCOPE_FUN_ASR_NATIVE_PATH}`,
    );
  });

  test("rejects browser direct on workspace endpoints with an actionable CORS message", () => {
    expect(
      resolveDashScopeFunAsrBrowserDirect({
        baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "fun-asr-realtime",
      }),
    ).toEqual({
      supported: false,
      code: "workspace-no-cors",
      message:
        "该 workspace DashScope endpoint 不支持浏览器 CORS，请关闭直连使用 proxy，或改用公共 DashScope endpoint。",
    });
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
