import { describe, expect, test } from "bun:test";
import {
  dailyStoryProviderCheckRequestSchema,
  dailyStoryReplyRequestSchema,
  dailyStoryReviewSuggestionSchema,
} from "./daily-story";

const chat = { baseUrl: "https://api.example.com/v1", apiKey: "test-key", model: "chat" };

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
});
