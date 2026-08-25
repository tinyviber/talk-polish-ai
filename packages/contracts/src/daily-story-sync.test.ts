import { describe, expect, test } from "bun:test";
import { dailyStorySyncConversationSchema, dailyStorySyncReviewSchema } from "./daily-story-sync";

function suggestion(index: number) {
  const sourceTurnId = `u${index}`;
  const original = `I went home ${index}.`;
  return {
    sourceTurnId,
    original,
    improved: `I headed home ${index}.`,
    category: "naturalness" as const,
    explanationZh: "更像自然口语。",
  };
}

function legacyReview() {
  return {
    score: 70,
    comment: "表达基本清楚。",
    rubric: null,
    suggestions: [suggestion(1), suggestion(2), suggestion(3)],
  };
}

describe("Daily Story legacy sync contracts", () => {
  test("continues accepting three suggestions in synced review snapshots", () => {
    expect(dailyStorySyncReviewSchema.parse(legacyReview()).suggestions).toHaveLength(3);

    const parsed = dailyStorySyncConversationSchema.parse({
      conversationId: "conversation-legacy-sync",
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-08-10T00:00:00.000Z",
      phase: "review",
      storyZh: "今天回家。",
      messages: [
        { id: "u1", role: "user", source: "typed", text: "I went home 1." },
        { id: "u2", role: "user", source: "typed", text: "I went home 2." },
        { id: "u3", role: "user", source: "typed", text: "I went home 3." },
      ],
      review: legacyReview(),
    });

    expect(parsed.review?.suggestions).toHaveLength(3);
  });
});
