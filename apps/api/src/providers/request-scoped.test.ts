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

  test("does not let the DashScope preset override an unrelated endpoint", () => {
    const providers = createDailyStoryRequestProviders(env(), {
      asr: {
        baseUrl: "https://api.example.com",
        apiKey: "secret-key",
        model: "qwen3-asr-flash",
        preset: "dashscope-compatible",
      },
    });
    expect(providers.asr?.name).toBe("daily-story-request-scoped-asr");
  });

  test("sends idempotency keys for Chat and TTS provider checks", async () => {
    const originalFetch = globalThis.fetch;
    const observed: Array<{ path: string; idempotencyKey: string | null }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      observed.push({
        path: url.pathname,
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      });
      if (url.pathname.endsWith("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    }) as typeof globalThis.fetch;

    try {
      const providers = createDailyStoryRequestProviders(
        { ...env(), NODE_ENV: "test", DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true },
        {
          chat: { baseUrl: "https://api.example.com", apiKey: "secret-key", model: "chat" },
          tts: {
            baseUrl: "https://api.example.com",
            apiKey: "secret-key",
            model: "tts",
            voice: "alloy",
          },
        },
      );
      await providers.chat?.check?.("chat-provider-check");
      await providers.tts?.check?.("tts-provider-check");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(observed).toEqual([
      { path: "/v1/chat/completions", idempotencyKey: "chat-provider-check" },
      { path: "/v1/audio/speech", idempotencyKey: "tts-provider-check" },
    ]);
  });
});
