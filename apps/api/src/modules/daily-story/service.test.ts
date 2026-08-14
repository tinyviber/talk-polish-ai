import { describe, expect, test } from "bun:test";
import type { TextModel, TextModelRequest } from "../../capabilities/text-model";
import type { DailyStoryProbe, DailyStoryRequestProviders } from "../../providers/request-scoped";
import { env } from "../../env";
import { createSafeProviderCall } from "./infrastructure/provider-call";
import type { DailyStoryGuard, DailyStoryProviderFactory } from "./application/ports";
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

function fixtureModel(
  values: unknown[],
  requests: TextModelRequest[] = [],
): TextModel & DailyStoryProbe {
  return {
    name: "fixture",
    async probe() {},
    async generate(input) {
      requests.push(input);
      const value = values.shift();
      return { content: JSON.stringify(value), provider: "fixture" };
    },
  };
}

function serviceFor(
  values: unknown[],
  requests: TextModelRequest[] = [],
  asrText = "The meeting spend too much time.  ",
) {
  return testService({
    providerFactory: () => ({
      chat: fixtureModel(values, requests),
      asr: {
        name: "fixture-asr",
        async probe() {},
        async transcribe() {
          return { text: asrText, provider: "fixture" };
        },
      },
    }),
    guard: async ({ run }) => run(),
  });
}

function testService(dependencies: {
  providerFactory?: (input: Parameters<DailyStoryProviderFactory>[0]) => unknown;
  guard?: DailyStoryGuard;
}) {
  const config = env();
  return createDailyStoryService({
    config: {
      dailyStoryRateLimitPerMinute: config.DAILY_STORY_RATE_LIMIT_PER_MINUTE,
      dailyStoryProviderCheckRateLimitPerMinute:
        config.DAILY_STORY_PROVIDER_CHECK_RATE_LIMIT_PER_MINUTE,
      dailyStoryConcurrentRequests: config.DAILY_STORY_CONCURRENT_REQUESTS,
    },
    providers: (input) => dependencies.providerFactory?.(input) as never,
    guard: dependencies.guard ?? (async ({ run }) => run()),
    safeProviderCall: createSafeProviderCall(config.NODE_ENV),
  });
}

describe("Daily Story policy service", () => {
  test("maps provider construction failures to validation errors", async () => {
    const service = testService({
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
    const service = testService({
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async probe(requestId?: string) {
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

  test("fails closed when a provider has no explicit probe capability", async () => {
    const service = testService({
      providerFactory: () =>
        ({
          chat: {
            name: "fixture-chat",
            async generate() {
              return { content: "", provider: "fixture" };
            },
          },
        }) as unknown as Partial<DailyStoryRequestProviders>,
      guard: async ({ run }) => run(),
    });

    await expect(
      service.providerCheck({
        learnerId: "learner",
        requestId: "missing-probe",
        request: { capability: "chat", provider: chatConfig },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_failed" });
  });

  test.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
  ] as const)("preserves rejected provider credentials as %i", async (status, code) => {
    const service = testService({
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async probe() {
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
    const service = testService({
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async probe() {
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
    const service = testService({
      providerFactory: () => ({
        chat: {
          name: "fixture-chat",
          async generate() {
            return { content: "", provider: "fixture" };
          },
          async probe() {
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
    const service = testService({
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
          async probe() {
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

  test("does not repair malformed optional title metadata or block opening", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ reply: "Welcome.", title: 42, titleBasis: { unexpected: true } }],
      requests,
    );

    const opening = await service.start({
      learnerId: "learner",
      requestId: "malformed-title-request",
      storyZh: "今天学校开会。",
      chat: chatConfig,
    });

    expect(opening.opening.text).toBe("Welcome.");
    expect(opening.title).toBe("今天学校开会");
    expect("titleBasis" in opening).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("falls back when title metadata grounds only a hallucinated event", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ reply: "Welcome.", title: "今天发生火灾", titleBasis: "今天" }],
      requests,
    );

    const opening = await service.start({
      learnerId: "learner",
      requestId: "hallucinated-title-request",
      storyZh: "今天去学校。",
      chat: chatConfig,
    });

    expect(opening.title).toBe("今天去学校");
    expect(requests).toHaveLength(1);
  });

  test("accepts a grounded generated title without another model request", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ reply: "Welcome.", title: "学校会议", titleBasis: "学校" }],
      requests,
    );

    const opening = await service.start({
      learnerId: "learner",
      requestId: "grounded-title-request",
      storyZh: "今天学校开了一个会议。",
      chat: chatConfig,
    });

    expect(opening.title).toBe("学校会议");
    expect(requests).toHaveLength(1);
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
    expect(prompt).toContain("assistant-7");
    expect(prompt).toContain("<LEARNER_USER_TURNS_FOR_SCORING_ONLY>");
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

  test("salvages overall feedback independently from malformed rubric or suggestions", async () => {
    const service = serviceFor([
      {
        overallFeedback:
          "你围绕会议经历展开了几轮交流，主要意思能够传达出来。整体表达带有一些重复，但话题推进是连贯的。",
        overall: 68,
        rubric: { grammar: "malformed" },
        suggestions: [{ sourceTurnId: "u1" }],
      },
    ]);

    await expect(service.review(reviewInput())).resolves.toEqual({
      score: 68,
      comment: "本次表达基本清楚，继续针对分项薄弱处练习。",
      overallFeedback:
        "你围绕会议经历展开了几轮交流，主要意思能够传达出来。整体表达带有一些重复，但话题推进是连贯的。",
      rubric: null,
      suggestions: [],
    });
  });

  test("fills a missing title in the same structured review request", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ rubric: rubric(), suggestions: [], title: "开会", titleBasis: "开会" }],
      requests,
    );

    await expect(service.review({ ...reviewInput(), includeTitle: true })).resolves.toMatchObject({
      title: "开会",
      score: 70,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[1]?.content).toContain("short Chinese title");
  });

  test("uses deterministic fallback for malformed review title without breaking review", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ rubric: rubric(), suggestions: [], title: 42, titleBasis: { nope: true } }],
      requests,
    );

    await expect(service.review({ ...reviewInput(), includeTitle: true })).resolves.toMatchObject({
      title: "今天开会",
      score: 70,
    });
    expect(requests).toHaveLength(1);
  });

  test("ignores model title when persisted title is already stable", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [{ rubric: rubric(), suggestions: [], title: "模型新标题", titleBasis: "今天" }],
      requests,
    );

    const result = await service.review({ ...reviewInput(), includeTitle: false });
    expect(result).not.toHaveProperty("title");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[1]?.content).toContain("Do not return title metadata");
  });

  test("repairs a scoreless no-suggestion result before returning", async () => {
    const requests: TextModelRequest[] = [];
    const service = serviceFor(
      [
        { rubric: null, overallFeedback: "暂缺分项评分。", suggestions: [] },
        { rubric: rubric(), suggestions: [] },
      ],
      requests,
    );

    await expect(service.review(reviewInput())).resolves.toMatchObject({ suggestions: [] });

    expect(requests).toHaveLength(2);
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

  test("normalizes the previous overall/scores response alongside the current rubric", async () => {
    const service = serviceFor([
      {
        overall: 88,
        scores: { fluency: 91, grammar: 80, vocabulary: 70, naturalness: 60 },
        suggestions: [],
      },
    ]);

    await expect(service.review(reviewInput())).resolves.toMatchObject({
      score: 75,
      rubric: {
        fluency: { score: 91 },
        grammar: { score: 80 },
        vocabulary: { score: 70 },
        naturalness: { score: 60 },
      },
    });
  });

  test("keeps a valid overall score when the provider omits all rubric fields", async () => {
    const service = serviceFor([{ overall: 88, suggestions: [] }]);

    await expect(service.review(reviewInput())).resolves.toMatchObject({
      score: 88,
      comment: "本次表达整体稳定，针对细节继续打磨会更自然。",
      rubric: null,
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
    expect(result.rawTranscript).toBe(result.transcript);
    expect(result.normalizedTranscript).toBe(result.transcript);
  });

  test("keeps ASR usable when no chat provider is configured", async () => {
    const service = testService({
      providerFactory: (input) =>
        input.asr
          ? {
              asr: {
                name: "fixture-asr",
                async probe() {},
                async transcribe() {
                  return { text: "I want to sea my friend", provider: "fixture" };
                },
              },
            }
          : {},
    });

    await expect(
      service.transcribe({
        learnerId: "learner",
        requestId: "no-chat",
        asr: { ...chatConfig },
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({
      transcript: "I want to sea my friend",
      rawTranscript: "I want to sea my friend",
      normalizedTranscript: "I want to sea my friend",
    });
  });

  test("falls back to raw ASR when the normalization provider fails", async () => {
    const service = testService({
      providerFactory: (input) => ({
        ...(input.asr
          ? {
              asr: {
                name: "fixture-asr",
                async probe() {},
                async transcribe() {
                  return { text: "I go there yesterday", provider: "fixture" };
                },
              },
            }
          : {}),
        ...(input.chat
          ? {
              chat: {
                name: "fixture-chat",
                async probe() {},
                async generate() {
                  throw new Error("timeout");
                },
              },
            }
          : {}),
      }),
    });

    await expect(
      service.transcribe({
        learnerId: "learner",
        requestId: "normalization-timeout",
        asr: { ...chatConfig },
        chat: chatConfig,
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({
      transcript: "I go there yesterday",
      rawTranscript: "I go there yesterday",
      normalizedTranscript: "I go there yesterday",
      changes: [],
    });
  });

  test("falls back to raw ASR when structured normalization remains malformed", async () => {
    let chatCalls = 0;
    const service = testService({
      providerFactory: (input) => ({
        ...(input.asr
          ? {
              asr: {
                name: "fixture-asr",
                async probe() {},
                async transcribe() {
                  return { text: "I I go to school", provider: "fixture" };
                },
              },
            }
          : {}),
        ...(input.chat
          ? {
              chat: {
                name: "fixture-chat",
                async probe() {},
                async generate() {
                  chatCalls += 1;
                  return { content: "not-json", provider: "fixture" };
                },
              },
            }
          : {}),
      }),
    });

    await expect(
      service.transcribe({
        learnerId: "learner",
        requestId: "normalization-malformed",
        asr: { ...chatConfig },
        chat: chatConfig,
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({
      transcript: "I I go to school",
      rawTranscript: "I I go to school",
      normalizedTranscript: "I I go to school",
      changes: [],
    });
    expect(chatCalls).toBe(2);
  });

  test("falls back to raw ASR when a homophone candidate is ambiguous", async () => {
    const service = serviceFor(
      [
        {
          normalizedText: "I want to see the ocean",
          changes: [{ category: "homophone", from: "sea", to: "see" }],
        },
      ],
      [],
      "I want to sea the ocean",
    );

    await expect(
      service.transcribe({
        learnerId: "learner",
        requestId: "ambiguous-homophone",
        asr: { ...chatConfig },
        chat: chatConfig,
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({
      transcript: "I want to sea the ocean",
      rawTranscript: "I want to sea the ocean",
      normalizedTranscript: "I want to sea the ocean",
      changes: [],
    });
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
