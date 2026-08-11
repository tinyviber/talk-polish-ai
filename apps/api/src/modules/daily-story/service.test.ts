import { describe, expect, test } from "bun:test";
import type { TextModel, TextModelRequest } from "../../capabilities/text-model";
import { env } from "../../env";
import { ApiError } from "../../http/errors";
import { ProviderRequestError } from "../../providers/http";
import { DailyProviderConfigurationError } from "../../providers/outbound-url-policy";
import { DailyProviderRequestError } from "../../providers/safe-https-client";
import {
  DAILY_STORY_OPENING_MAX_TOKENS,
  conversationSystemPrompt,
  openingUserPrompt,
} from "./policy";
import { createDailyStoryService } from "./service";

const chatConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "secret-test-key",
  model: "fixture",
};

function fixtureModel(values: unknown[], requests: TextModelRequest[] = []): TextModel {
  return {
    name: "fixture",
    async generate(input) {
      requests.push(input);
      const value = values.shift();
      return { content: JSON.stringify(value), provider: "fixture" };
    },
  };
}

function serviceFor(values: unknown[], requests: TextModelRequest[] = []) {
  return createDailyStoryService(env(), {
    providerFactory: () => ({
      chat: fixtureModel(values, requests),
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
  test("maps provider construction failures to validation errors", async () => {
    const service = createDailyStoryService(env(), {
      providerFactory: () => {
        throw new DailyProviderConfigurationError();
      },
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "request",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "validation_failed",
    });
  });

  test("passes the request ID into provider checks", async () => {
    const requestIds: string[] = [];
    const service = createDailyStoryService(env(), {
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async check(requestId?: string) {
            if (requestId) requestIds.push(requestId);
          },
        },
      }),
      guard: async ({ run }) => run(),
    });

    await service.providerCheck({
      learnerId: "learner",
      requestId: "provider-check-request",
      request: { capability: "chat", provider: chatConfig },
    });

    expect(requestIds).toEqual(["provider-check-request"]);
  });

  test.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
  ] as const)("preserves rejected provider credentials as %i", async (status, code) => {
    const service = createDailyStoryService(env(), {
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async check() {
            throw new DailyProviderRequestError("http", status);
          },
        },
      }),
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "request",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({ statusCode: 401, code });
  });

  test("preserves provider rate limits as 429", async () => {
    const service = createDailyStoryService(env(), {
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async check() {
            throw new DailyProviderRequestError("http", 429);
          },
        },
      }),
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "request",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });
  });

  test("does not label a generic provider 415 as a Fun-ASR MIME error", async () => {
    const service = createDailyStoryService(env(), {
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async check() {
            throw new DailyProviderRequestError("http", 415);
          },
        },
      }),
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "request",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "processing_unavailable",
      message: "Daily Story provider is temporarily unavailable.",
    });
  });

  test("preserves AI SDK provider auth failures as 401", async () => {
    const service = createDailyStoryService(env(), {
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            throw new ProviderRequestError("Upstream chat request failed.", {
              code: "http",
              status: 401,
              retryCount: 0,
            });
          },
          async check() {
            throw new ProviderRequestError("Upstream chat request failed.", {
              code: "http",
              status: 401,
              retryCount: 0,
            });
          },
        },
      }),
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "request",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: "unauthorized" });
  });

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

  test("uses JSON mode and bounded budgets for start, reply, and review", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [
        { reply: "That sounds like a long day. What happened next?" },
        { understanding: "understood", reply: "That sounds tiring." },
        { suggestions: [] },
      ],
      requests,
    );
    const opening = await service.start({
      learnerId: "learner",
      requestId: "start-request",
      storyZh: "今天很忙。",
      chat: chatConfig,
    });
    const reply = await service.reply({
      learnerId: "learner",
      requestId: "reply-request",
      storyZh: "今天很忙。",
      history: [opening.opening],
      turn: { id: "u1", source: "typed", text: "I was busy." },
      chat: chatConfig,
    });
    await service.review({
      learnerId: "learner",
      requestId: "review-request",
      storyZh: "今天很忙。",
      history: [
        opening.opening,
        { id: "u1", role: "user", source: "typed", text: "I was busy." },
        { id: "a1", role: "assistant", text: reply.reply },
      ],
      chat: chatConfig,
    });

    expect(
      requests.map(({ responseFormat, maxTokens }) => ({ responseFormat, maxTokens })),
    ).toEqual([
      { responseFormat: "json", maxTokens: DAILY_STORY_OPENING_MAX_TOKENS },
      { responseFormat: "json", maxTokens: 512 },
      { responseFormat: "json", maxTokens: 768 },
    ]);
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: conversationSystemPrompt },
      { role: "user", content: openingUserPrompt("今天很忙。") },
    ]);
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
