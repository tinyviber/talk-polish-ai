import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { TextModel, TextModelRequest } from "../../../platform/ai/capabilities";
import type { ProviderProbe } from "../../../platform/ai/probe";
import type { DailyStoryRuntimeConfig } from "./ports";
import {
  createReviewConversation,
  reviewConversationPolicy,
  type ReviewConversationInput,
} from "./review-conversation";

const chatConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "secret-test-key",
  model: "fixture",
};

const input: ReviewConversationInput = {
  learnerId: "learner",
  requestId: "review-request",
  storyZh: "今天开会。",
  history: [{ id: "u1", role: "user", source: "typed", text: "The meeting was long." }],
  chat: chatConfig,
};

const modelResult = {
  score: 70,
  rubric: {
    fluency: { score: 70, comment: "表达连贯。", evidence: [] },
    grammar: { score: 70, comment: "语法稳定。", evidence: [] },
    vocabulary: { score: 70, comment: "词汇够用。", evidence: [] },
    naturalness: { score: 70, comment: "表达自然。", evidence: [] },
  },
  suggestions: [],
};

const runtimeConfig: DailyStoryRuntimeConfig = {
  dailyStoryRateLimitPerMinute: 12,
  dailyStoryProviderCheckRateLimitPerMinute: 3,
  dailyStoryConcurrentRequests: 2,
};

describe("review conversation application", () => {
  test("depends on ports instead of provider wiring", async () => {
    const source = await readFile(new URL("./review-conversation.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/providers\//);
    expect(source).not.toMatch(/request-guards|DailyStoryRequestProviders/);
    expect(source).toMatch(/\.\/ports/);
    expect(source).not.toMatch(/platform\/ai\/transport/);
  });

  test("injects guard, provider factory, safe provider call, and policy", async () => {
    const requests: TextModelRequest[] = [];
    let guardedCapability = "";
    let providerConfig: unknown;
    let safeCallRequestId = "";
    const chat: TextModel & ProviderProbe = {
      name: "fixture",
      async probe() {},
      async generate(request) {
        requests.push(request);
        return { content: JSON.stringify(modelResult), provider: "fixture" };
      },
    };
    const review = createReviewConversation({
      config: runtimeConfig,
      providerFactory(input) {
        providerConfig = input.chat;
        return { chat };
      },
      guard: async ({ capability, run }) => {
        guardedCapability = capability;
        return run();
      },
      safeProviderCall: async (run, requestId) => {
        safeCallRequestId = requestId ?? "";
        return run();
      },
      policy: {
        ...reviewConversationPolicy,
        systemPrompt: "injected system prompt",
        maxTokens: 123,
      },
    });

    await expect(review(input)).resolves.toMatchObject({ score: 70, suggestions: [] });
    expect(guardedCapability).toBe("review");
    expect(providerConfig).toEqual(chatConfig);
    expect(safeCallRequestId).toBe("review-request");
    expect(requests[0]).toMatchObject({
      maxTokens: 123,
      messages: [
        { role: "system", content: "injected system prompt" },
        { role: "user", content: expect.any(String) },
      ],
    });
  });

  test("rejects review without a submitted user turn before constructing a provider", async () => {
    let providerCreated = false;
    const review = createReviewConversation({
      config: runtimeConfig,
      providerFactory() {
        providerCreated = true;
        return {};
      },
      guard: async ({ run }) => run(),
      safeProviderCall: async (run) => run(),
      policy: reviewConversationPolicy,
    });

    await expect(
      review({
        ...input,
        history: [{ id: "a1", role: "assistant", text: "Hello." }],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "Conversation needs a user turn before review.",
    });
    expect(providerCreated).toBe(false);
  });
});
