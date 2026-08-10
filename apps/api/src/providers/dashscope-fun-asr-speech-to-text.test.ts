import { describe, expect, test } from "bun:test";
import { env } from "../env";
import {
  createDashScopeFunAsrBody,
  createDashScopeFunAsrProbeAudio,
  isDashScopeFunAsrProvider,
  parseDashScopeFunAsrTranscript,
} from "./dashscope-fun-asr-speech-to-text";
import { DailyProviderRequestError } from "./safe-https-client";

describe("DashScope native Fun-ASR HTTP adapter", () => {
  test("builds the native Base64 audio request", () => {
    const body = createDashScopeFunAsrBody(
      "fun-asr-realtime",
      Uint8Array.from([0, 1, 2]),
      "audio/wav; codecs=pcm",
    );
    expect(body).toMatchObject({
      model: "fun-asr-realtime",
      parameters: { format: "wav" },
      resources: [],
    });
    expect(body.input.messages[0]?.content[0]?.audio).toBe("data:audio/wav;base64,AAEC");
  });

  test("accepts only official Fun-ASR-Realtime model ids", () => {
    const baseUrl = "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    expect(isDashScopeFunAsrProvider({ baseUrl, model: "fun-asr-realtime" })).toBe(true);
    expect(isDashScopeFunAsrProvider({ baseUrl, model: "fun-asr-realtime-2026-02-28" })).toBe(true);
    expect(isDashScopeFunAsrProvider({ baseUrl, model: "fun-asr-realtime-future" })).toBe(false);
  });

  test("uses a non-silent speech fixture for provider checks", () => {
    const audio = createDashScopeFunAsrProbeAudio();
    expect(Buffer.from(audio).subarray(0, 3).toString()).toBe("ID3");
    expect(audio.length).toBeGreaterThan(100);
  });

  test("parses the native output text without trimming it", () => {
    expect(parseDashScopeFunAsrTranscript({ output: { text: " hello from fun asr  " } })).toEqual({
      text: " hello from fun asr  ",
      provider: "dashscope-fun-asr",
    });
  });

  test("supports the sentence fallback and rejects missing text", () => {
    expect(parseDashScopeFunAsrTranscript({ output: { sentence: { text: "hello" } } })).toEqual({
      text: "hello",
      provider: "dashscope-fun-asr",
    });
    expect(() => parseDashScopeFunAsrTranscript({ output: {} })).toThrow(DailyProviderRequestError);
  });

  test("sends the native endpoint and request headers", async () => {
    const originalFetch = globalThis.fetch;
    let observed: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input, init) => {
      observed = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(
          init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : String(init?.body),
        ) as Record<string, unknown>,
      };
      return Response.json({ output: { text: "hello" } });
    }) as typeof fetch;

    try {
      const { createDashScopeFunAsrSpeechToText } =
        await import("./dashscope-fun-asr-speech-to-text");
      const provider = createDashScopeFunAsrSpeechToText(
        { ...env(), NODE_ENV: "test", DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS: true },
        {
          baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          apiKey: "secret-key",
          model: "fun-asr-realtime",
        },
      );
      await provider.transcribe({
        audio: Uint8Array.from([0, 1, 2]),
        mimeType: "audio/wav",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(observed?.url).toBe(
      "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(observed?.headers.get("x-dashscope-sse")).toBe("disable");
    expect(observed?.body).toMatchObject({ model: "fun-asr-realtime", resources: [] });
  });
});
