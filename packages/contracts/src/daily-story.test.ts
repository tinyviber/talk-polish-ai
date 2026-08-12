import { describe, expect, test } from "bun:test";
import {
  dailyProviderBaseUrlSchema,
  dailyStoryAsrConfigSchema,
  dailyStoryChatConfigSchema,
  dailyStoryProviderCheckRequestSchema,
  dailyStoryReplyRequestSchema,
  dailyStoryReviewDiffSchema,
  dailyStoryReviewResponseSchema,
  dailyStoryReviewSuggestionSchema,
  dailyStoryTtsConfigSchema,
} from "./daily-story";

const chat = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "chat",
  preset: "openai-compatible" as const,
};

describe("Daily Story contracts", () => {
  test("keeps provider checks capability-discriminated and strict", () => {
    expect(
      dailyStoryProviderCheckRequestSchema.parse({ capability: "chat", provider: chat }),
    ).toEqual({
      capability: "chat",
      provider: chat,
    });
    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "chat",
        provider: { ...chat, voice: "alloy" },
      }).success,
    ).toBe(false);
    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "asr",
        provider: {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "test-key",
          model: "fun-asr-realtime",
          responseFormat: "json",
          directAsr: true,
        },
      }).success,
    ).toBe(false);
  });

  test("rejects provider capability combinations that have no adapter", () => {
    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "asr",
        provider: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "test-key",
          model: "deepseek-v4-flash",
          preset: "deepseek",
        },
      }).success,
    ).toBe(false);

    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "asr",
        provider: {
          baseUrl: "https://provider.example.com/custom/v1",
          apiKey: "test-key",
          model: "asr-model",
          preset: "deepseek",
        },
      }).success,
    ).toBe(true);
    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "tts",
        provider: {
          baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          apiKey: "test-key",
          model: "qwen-plus",
          preset: "dashscope-compatible",
          voice: "alloy",
        },
      }).success,
    ).toBe(false);

    expect(
      dailyStoryProviderCheckRequestSchema.safeParse({
        capability: "tts",
        provider: {
          baseUrl: "https://provider.example.com/custom/v1",
          apiKey: "test-key",
          model: "tts-model",
          preset: "dashscope-compatible",
          voice: "alloy",
        },
      }).success,
    ).toBe(true);
  });

  test("rejects stale presets for known endpoints but permits custom metadata", () => {
    expect(
      dailyStoryChatConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "chat",
        preset: "dashscope-compatible",
      }).success,
    ).toBe(false);
    expect(
      dailyStoryAsrConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "whisper-1",
        preset: "deepseek",
      }).success,
    ).toBe(false);
    expect(
      dailyStoryTtsConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "tts",
        preset: "dashscope-compatible",
        voice: "alloy",
      }).success,
    ).toBe(false);

    const customBaseUrl = "https://provider.example.com/custom/v1";
    expect(
      dailyStoryChatConfigSchema.safeParse({
        baseUrl: customBaseUrl,
        apiKey: "test-key",
        model: "chat",
        preset: "dashscope-compatible",
      }).success,
    ).toBe(true);
    expect(
      dailyStoryAsrConfigSchema.safeParse({
        baseUrl: customBaseUrl,
        apiKey: "test-key",
        model: "asr",
        preset: "deepseek",
      }).success,
    ).toBe(true);
    expect(
      dailyStoryTtsConfigSchema.safeParse({
        baseUrl: customBaseUrl,
        apiKey: "test-key",
        model: "tts",
        preset: "dashscope-compatible",
        voice: "alloy",
      }).success,
    ).toBe(true);
  });

  test("normalizes legacy provider roots at the contract boundary", () => {
    expect(dailyProviderBaseUrlSchema.parse(" https://api.deepseek.com/ ")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(
      dailyProviderBaseUrlSchema.parse(
        "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      ),
    ).toBe("https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(dailyProviderBaseUrlSchema.safeParse("http://api.example.com").success).toBe(false);
    expect(dailyProviderBaseUrlSchema.safeParse("https://api.example.com?key=secret").success).toBe(
      false,
    );
  });

  test("keeps typed turns distinct and rejects duplicate history ids", () => {
    const user = { id: "u1", role: "user" as const, source: "typed" as const, text: "I was late." };
    expect(
      dailyStoryReplyRequestSchema.safeParse({
        storyZh: "今天开会很长。",
        chat,
        turn: { id: "u2", source: "asr", text: "The meeting spend too much time." },
        history: [user, user],
      }).success,
    ).toBe(false);
  });

  test("bounds review output to exact compact fields", () => {
    const suggestion = {
      sourceTurnId: "u1",
      original: "The meeting spend too much time.",
      improved: "The meeting took too long.",
      category: "naturalness" as const,
      explanationZh: "用 took too long 更自然。",
    };
    expect(dailyStoryReviewSuggestionSchema.parse(suggestion).sourceTurnId).toBe("u1");
    const { category: _category, ...withoutCategory } = suggestion;
    expect(dailyStoryReviewSuggestionSchema.safeParse(withoutCategory).success).toBe(false);
  });

  test("keeps new review fields optional for rolling API compatibility", () => {
    expect(
      dailyStoryReviewResponseSchema.parse({
        suggestions: [],
        requestId: "legacy-review",
      }),
    ).toEqual({ suggestions: [], requestId: "legacy-review" });
  });

  test("bounds compact review diffs and rejects diffs without a deletion", () => {
    expect(
      dailyStoryReviewDiffSchema.parse([
        ["=", "I "],
        ["-", "go"],
        ["=", " home."],
      ]),
    ).toHaveLength(3);
    expect(dailyStoryReviewDiffSchema.safeParse([["=", "I go home."]]).success).toBe(false);
    expect(
      dailyStoryReviewDiffSchema.safeParse([
        ["=", "I"],
        ["=", " go"],
        ["-", " home"],
      ]).success,
    ).toBe(false);
  });

  test("requires a compact diff to reconstruct the original exactly", () => {
    expect(
      dailyStoryReviewSuggestionSchema.safeParse({
        sourceTurnId: "u1",
        original: "I go home.",
        diff: [
          ["=", "I "],
          ["-", "go"],
          ["=", " there."],
        ],
        improved: "I went home.",
        category: "grammar",
        explanationZh: "动词形式需要调整。",
      }).success,
    ).toBe(false);
  });
});
