import { describe, expect, test } from "bun:test";
import {
  DAILY_STORY_OPENING_MAX_TOKENS,
  conversationSystemPrompt,
} from "../modules/daily-story/policy";
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

  test("selects the native DashScope Fun-ASR adapter by model", () => {
    const providers = createDailyStoryRequestProviders(env(), {
      asr: {
        baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        apiKey: "secret-key",
        model: "fun-asr-realtime",
      },
    });
    expect(providers.asr?.name).toBe("dashscope-fun-asr");
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

  test("uses a structured JSON probe and sends idempotency keys", async () => {
    const originalFetch = globalThis.fetch;
    const observed: Array<{
      path: string;
      idempotencyKey: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>;
      observed.push({
        path: url.pathname,
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
        body,
      });
      if (url.pathname.endsWith("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: '{"reply":"OK"}' } }] });
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
          chat: {
            baseUrl: "https://api.deepseek.com",
            apiKey: "secret-key",
            model: "deepseek-v4-flash",
            preset: "deepseek",
          },
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

    expect(observed.map(({ path, idempotencyKey }) => ({ path, idempotencyKey }))).toEqual([
      { path: "/v1/chat/completions", idempotencyKey: "chat-provider-check" },
      { path: "/v1/audio/speech", idempotencyKey: "tts-provider-check" },
    ]);
    expect(observed[0]?.body).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: DAILY_STORY_OPENING_MAX_TOKENS,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    expect(observed[0]?.body.messages).toEqual(
      expect.arrayContaining([
        { role: "system", content: conversationSystemPrompt },
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Start conversation now."),
        }),
      ]),
    );
  });

  test("does not inject DeepSeek thinking options for ordinary providers", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: '{"reply":"OK"}' } }] });
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    }) as typeof globalThis.fetch;

    try {
      const providers = createDailyStoryRequestProviders(
        { ...env(), NODE_ENV: "test", DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true },
        {
          chat: { baseUrl: "https://api.example.com", apiKey: "secret-key", model: "chat" },
        },
      );
      await providers.chat?.generate({
        messages: [{ role: "user", content: "probe" }],
        responseFormat: "json",
        maxTokens: 64,
        requestId: "ordinary-provider",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodies[0]).toMatchObject({
      model: "chat",
      max_tokens: 64,
      response_format: { type: "json_object" },
    });
    expect(bodies[0]).not.toHaveProperty("thinking");
  });

  test("derives DeepSeek options from the canonical endpoint, not the client preset", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = async (input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: '{"reply":"OK"}' } }] });
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    }) as typeof globalThis.fetch;

    try {
      const config = {
        ...env(),
        NODE_ENV: "test" as const,
        DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true,
      };
      const providers = [
        {
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "secret-key",
          model: "deepseek-chat",
        },
        {
          baseUrl: "https://api.deepseek.com",
          apiKey: "secret-key",
          model: "deepseek-chat",
          preset: "openai-compatible" as const,
        },
        {
          baseUrl: "https://proxy.example.com/v1",
          apiKey: "secret-key",
          model: "deepseek-chat",
          preset: "deepseek" as const,
        },
      ];
      for (const chat of providers) {
        const model = createDailyStoryRequestProviders(config, { chat }).chat;
        await model?.generate({
          messages: [{ role: "user", content: "probe" }],
          responseFormat: "json",
          maxTokens: 64,
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodies[0]).toHaveProperty("thinking", { type: "disabled" });
    expect(bodies[1]).toHaveProperty("thinking", { type: "disabled" });
    expect(bodies[2]).not.toHaveProperty("thinking");
  });

  test("fails a provider check when JSON output remains invalid", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const fetchMock = async () => {
      requests += 1;
      return Response.json({ choices: [{ message: { content: "not-json" } }] });
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    }) as typeof globalThis.fetch;

    try {
      const providers = createDailyStoryRequestProviders(
        { ...env(), NODE_ENV: "test", DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true },
        {
          chat: {
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "secret-key",
            model: "deepseek-v4-flash",
            preset: "deepseek",
          },
        },
      );
      await expect(providers.chat?.check?.("invalid-json-check")).rejects.toMatchObject({
        code: "structured_generation",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toBe(2);
  });

  test("fails a provider check when JSON has the wrong opening shape", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const fetchMock = async () => {
      requests += 1;
      return Response.json({
        choices: [{ message: { content: '{"understanding":"understood","reply":"OK"}' } }],
      });
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    }) as typeof globalThis.fetch;

    try {
      const providers = createDailyStoryRequestProviders(
        { ...env(), NODE_ENV: "test", DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true },
        {
          chat: {
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "secret-key",
            model: "deepseek-v4-flash",
            preset: "deepseek",
          },
        },
      );
      await expect(providers.chat?.check?.("invalid-opening-shape")).rejects.toMatchObject({
        code: "structured_generation",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toBe(2);
  });
});
