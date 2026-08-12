import { describe, expect, test } from "bun:test";
import type { TextModel, TextModelRequest } from "../../capabilities/text-model";
import { env } from "../../env";
import { ProviderRequestError } from "../../providers/http";
import { DailyProviderConfigurationError } from "../../providers/outbound-url-policy";
import { DailyProviderRequestError } from "../../providers/safe-https-client";
import {
  DAILY_STORY_OPENING_MAX_TOKENS,
  conversationSystemPrompt,
  openingUserPrompt,
  reviewResultSchema,
  reviewSystemPrompt,
} from "./policy";
import { createDailyStoryService, DAILY_STORY_REVIEW_MAX_TOKENS } from "./service";

const chatConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "secret-test-key",
  model: "fixture",
};

function rubric(scores = { fluency: 70, grammar: 70, vocabulary: 70, naturalness: 70 }) {
  return Object.fromEntries(
    Object.entries(scores).map(([key, score]) => [
      key,
      { score, comment: `${key} 客观短评`, evidence: [] },
    ]),
  );
}

function reviewInput() {
  return {
    learnerId: "learner",
    requestId: "review-request",
    storyZh: "今天开会。",
    history: [
      { id: "u1", role: "user" as const, source: "typed" as const, text: "The meeting was long." },
    ],
    chat: chatConfig,
  };
}

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
        { rubric: rubric(), suggestions: [] },
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
      { responseFormat: "json", maxTokens: DAILY_STORY_REVIEW_MAX_TOKENS },
    ]);
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: conversationSystemPrompt },
      { role: "user", content: openingUserPrompt("今天很忙。") },
    ]);
  });

  test("keeps review context to recent user turns", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor([{ rubric: rubric(), suggestions: [] }], requests);
    const history = Array.from({ length: 8 }, (_, index) => [
      { id: `a${index}`, role: "assistant" as const, text: `assistant-${index}` },
      {
        id: `u${index}`,
        role: "user" as const,
        source: "typed" as const,
        text: `turn-${index}-${"x".repeat(1_900)}`,
      },
    ]).flat();

    await service.review({
      ...reviewInput(),
      history,
    });

    const prompt = requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain('"id":"u7"');
    expect(prompt).not.toContain('"id":"u0"');
    expect(prompt).not.toContain("assistant-7");
  });

  test("requires a complete rubric when there are no suggestions", () => {
    expect(reviewResultSchema.safeParse({ rubric: rubric(), suggestions: [] }).success).toBe(true);
    expect(reviewResultSchema.safeParse({ suggestions: [] }).success).toBe(false);
    expect(reviewSystemPrompt).toContain(
      "still return the complete rubric with all four dimensions: fluency, grammar, vocabulary, and naturalness",
    );
  });

  test("keeps an empty-suggestion review on the first model call", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor([{ rubric: rubric(), suggestions: [] }], requests);

    await expect(service.review(reviewInput())).resolves.toMatchObject({ suggestions: [] });

    expect(requests).toHaveLength(1);
  });

  test("repairs an incomplete no-suggestion result with the complete rubric instruction", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ suggestions: [] }, { rubric: rubric(), suggestions: [] }],
      requests,
    );

    await expect(service.review(reviewInput())).resolves.toMatchObject({ suggestions: [] });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "Even when there are no useful improvements, include the complete rubric with fluency, grammar, vocabulary, and naturalness",
    );
  });

  test("restores review originals from submitted history", async () => {
    const service = serviceFor([
      {
        rubric: rubric(),
        suggestions: [
          {
            sourceTurnId: "u1",
            diff: [
              ["=", "The meeting "],
              ["-", "spend"],
              ["=", " too much time."],
            ],
            improved: "The meeting took too long.",
            category: "naturalness",
            explanationZh: "更自然。",
          },
        ],
      },
    ]);
    const result = await service.review({
      learnerId: "learner",
      requestId: "review-request",
      storyZh: "今天开会。",
      history: [
        { id: "u1", role: "user", source: "typed", text: "The meeting spend too much time." },
      ],
      chat: chatConfig,
    });
    expect(result.suggestions).toEqual([
      {
        sourceTurnId: "u1",
        original: "The meeting spend too much time.",
        diff: [
          ["=", "The meeting "],
          ["-", "spend"],
          ["=", " too much time."],
        ],
        improved: "The meeting took too long.",
        category: "naturalness",
        explanationZh: "更自然。",
      },
    ]);
  });

  test("calculates the overall score server-side and preserves valid evidence", async () => {
    const service = serviceFor([
      {
        rubric: {
          ...rubric({ fluency: 91, grammar: 80, vocabulary: 70, naturalness: 60 }),
          fluency: {
            score: 91,
            comment: "表达连贯。",
            evidence: [{ sourceTurnId: "u1", quote: "meeting was long" }],
          },
        },
        suggestions: [],
      },
    ]);

    await expect(service.review(reviewInput())).resolves.toMatchObject({
      score: 75,
      comment: "本次表达整体稳定，针对细节继续打磨会更自然。",
      rubric: {
        fluency: {
          score: 91,
          evidence: [{ sourceTurnId: "u1", quote: "meeting was long" }],
        },
      },
    });
  });

  test("keeps the review usable when a suggestion diff is invalid", async () => {
    const service = serviceFor([
      {
        rubric: rubric(),
        suggestions: [
          {
            sourceTurnId: "u1",
            diff: [
              ["=", "The meeting "],
              ["-", "spend"],
            ],
            improved: "The meeting took too long.",
            category: "grammar",
            explanationZh: "动词形式需要调整。",
          },
        ],
      },
    ]);

    const result = await service.review(reviewInput());
    expect(result.suggestions).toEqual([
      {
        sourceTurnId: "u1",
        original: "The meeting was long.",
        improved: "The meeting took too long.",
        category: "grammar",
        explanationZh: "动词形式需要调整。",
      },
    ]);
  });

  test("drops rubric evidence whose quote is not in the submitted user turn", async () => {
    const service = serviceFor([
      {
        rubric: {
          ...rubric(),
          grammar: {
            score: 70,
            comment: "需要继续练习。",
            evidence: [{ sourceTurnId: "u1", quote: "model-invented wording" }],
          },
        },
        suggestions: [],
      },
    ]);

    await expect(service.review(reviewInput())).resolves.toMatchObject({
      rubric: { grammar: { evidence: [] } },
    });
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

  test("skips review suggestions with an unknown source turn", async () => {
    const service = serviceFor([
      {
        rubric: rubric(),
        suggestions: [
          {
            sourceTurnId: "unknown",
            diff: [["-", "The meeting was too long."]],
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
    ).resolves.toMatchObject({ suggestions: [] });
  });

  test("keeps only one review suggestion per source turn", async () => {
    const service = serviceFor([
      {
        rubric: rubric(),
        suggestions: [
          {
            sourceTurnId: "u1",
            diff: [["-", "The meeting spend too much time."]],
            improved: "The meeting was too long.",
            category: "grammar",
            explanationZh: "更自然。",
          },
          {
            sourceTurnId: "u1",
            diff: [["-", "The meeting spend too much time."]],
            improved: "The meeting took too long.",
            category: "naturalness",
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
    ).resolves.toMatchObject({
      suggestions: [{ sourceTurnId: "u1", improved: "The meeting was too long." }],
    });
  });
});
