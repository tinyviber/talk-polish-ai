import { describe, expect, test } from "bun:test";
import { env } from "../env";
import { createDailyStoryRequestProviders, normalizeDailyStoryProvider } from "./request-scoped";

describe("request-scoped provider catalog", () => {
  test("normalizes legacy provider settings before transport construction", () => {
    expect(
      normalizeDailyStoryProvider({
        baseUrl: "https://api.deepseek.com",
        apiKey: "secret-key",
        model: "deepseek-chat",
      }),
    ).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "secret-key",
      model: "deepseek-chat",
    });
  });

  test("selects the DashScope-compatible ASR adapter after legacy path completion", () => {
    const providers = createDailyStoryRequestProviders(env(), {
      asr: {
        baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode",
        apiKey: "secret-key",
        model: "qwen3-asr-flash",
      },
    });
    expect(providers.asr?.name).toBe("dashscope-compatible-asr");
  });
});
