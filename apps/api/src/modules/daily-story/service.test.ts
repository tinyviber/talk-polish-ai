import { describe, expect, test } from "bun:test";
import type { TextModel } from "../../capabilities/text-model";
import { env } from "../../env";
import { ApiError } from "../../http/errors";
import { createDailyStoryService } from "./service";

const chatConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "secret-test-key",
  model: "fixture",
};

function fixtureModel(values: unknown[]): TextModel {
  return {
    name: "fixture",
    async generate() {
      const value = values.shift();
      return { content: JSON.stringify(value), provider: "fixture" };
    },
  };
}

function serviceFor(values: unknown[]) {
  return createDailyStoryService(env(), {
    providerFactory: () => ({
      chat: fixtureModel(values),
      asr: {
        name: "fixture-asr",
        async transcribe() {
          return { text: "The meeting spend too much time.  ", provider: "fixture" };
        },
      },
    }),
    guard: async ({ run }) => run(),
  });
}

describe("Daily Story policy service", () => {
  test("starts conversationally and preserves structured reply understanding", async () => {
    const service = serviceFor([
      { reply: "That sounds like a long day. What was the meeting mainly about?" },
      {
        understanding: "understood",
        reply: "Yeah, that can be tiring. What part took the most time?",
      },
    ]);
    const opening = await service.start({
      learnerId: "learner",
      requestId: "request",
      storyZh: "今天学校临时开了一个很长的会。",
      chat: chatConfig,
    });
    expect(opening.opening.role).toBe("assistant");
    const reply = await service.reply({
      learnerId: "learner",
      requestId: "request",
      storyZh: "今天学校临时开了一个很长的会。",
      history: [opening.opening],
      turn: { id: "u1", source: "asr", text: "The meeting spend too much time." },
      chat: chatConfig,
    });
    expect(reply.understanding).toBe("understood");
    expect(reply.reply).not.toContain("should say");
  });

  test("keeps ASR text verbatim, including trailing whitespace", async () => {
    const service = serviceFor([]);
    const result = await service.transcribe({
      learnerId: "learner",
      requestId: "request",
      asr: { ...chatConfig },
      audio: new Uint8Array([1, 2]),
      mimeType: "audio/webm",
    });
    expect(result.transcript).toBe("The meeting spend too much time.  ");
  });

  test("rejects review suggestions whose original is not exact submitted source", async () => {
    const service = serviceFor([
      {
        suggestions: [
          {
            sourceTurnId: "u1",
            original: "The meeting took too long.",
            improved: "The meeting was too long.",
            category: "grammar",
            explanationZh: "更自然。",
          },
        ],
      },
    ]);
    await expect(
      service.review({
        learnerId: "learner",
        requestId: "request",
        storyZh: "今天开会。",
        history: [
          { id: "u1", role: "user", source: "typed", text: "The meeting spend too much time." },
        ],
        chat: chatConfig,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
