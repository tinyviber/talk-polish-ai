import { describe, expect, test } from "bun:test";
import type { DailyStoryProviderCheckRequest } from "@kotoba/contracts";
import type { DailyStoryProviders } from "./ports";
import { createCheckProvider } from "./check-provider";

const config = {
  dailyStoryRateLimitPerMinute: 12,
  dailyStoryProviderCheckRateLimitPerMinute: 3,
  dailyStoryConcurrentRequests: 2,
};

const provider = (calls: string[], name: string) => ({
  name,
  async probe(requestId?: string) {
    calls.push(`${name}:${requestId}`);
  },
  async generate() {
    return { content: "{}", provider: name };
  },
  async transcribe() {
    return { text: "", provider: name };
  },
  async synthesize() {
    return { bytes: new Uint8Array(), contentType: "audio/mpeg", provider: name };
  },
});

describe("Daily Story provider check use case", () => {
  test("selects chat, ASR, TTS and uses the provider-check rate limit", async () => {
    const calls: string[] = [];
    const guardInputs: Array<{ capability: string; perMinute: number }> = [];
    const providers = (input: Parameters<(input: any) => DailyStoryProviders>[0]) => {
      const result: DailyStoryProviders = {};
      if (input.chat) result.chat = provider(calls, "chat") as never;
      if (input.asr) result.asr = provider(calls, "asr") as never;
      if (input.tts) result.tts = provider(calls, "tts") as never;
      return result;
    };
    const check = createCheckProvider({
      config,
      providers,
      guard: async (input) => {
        guardInputs.push({ capability: input.capability, perMinute: input.perMinute });
        return input.run();
      },
      safeProviderCall: async (run) => run(),
    });
    const requests = [
      { capability: "chat", provider: { baseUrl: "https://example.com", apiKey: "x", model: "m" } },
      { capability: "asr", provider: { baseUrl: "https://example.com", apiKey: "x", model: "m" } },
      {
        capability: "tts",
        provider: { baseUrl: "https://example.com", apiKey: "x", model: "m", voice: "alloy" },
      },
    ] as DailyStoryProviderCheckRequest[];
    for (const request of requests) {
      await check({ learnerId: "learner", requestId: "request", request });
    }
    expect(calls).toEqual(["chat:request", "asr:request", "tts:request"]);
    expect(guardInputs).toEqual([
      { capability: "check:chat", perMinute: 3 },
      { capability: "check:asr", perMinute: 3 },
      { capability: "check:tts", perMinute: 3 },
    ]);
  });
});
