import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  sessionSchema,
  storyExportSessionSchema,
} from "@/features/daily-story/persistence/internal/schemas";

function legacySuggestion(index: number) {
  return {
    sourceTurnId: `u${index}`,
    original: `I went home ${index}.`,
    improved: `I headed home ${index}.`,
    category: "naturalness" as const,
    explanationZh: "更像自然口语。",
  };
}

function legacyMessages() {
  return [
    { id: "u1", role: "user" as const, source: "typed" as const, text: "I went home 1." },
    { id: "u2", role: "user" as const, source: "typed" as const, text: "I went home 2." },
    { id: "u3", role: "user" as const, source: "typed" as const, text: "I went home 3." },
  ];
}

describe("Daily Story review copy", () => {
  test("uses neutral native-recast labels and plays the improved expression", async () => {
    const source = await readFile(new URL("./ui/Review.tsx", import.meta.url), "utf8");

    expect(source).toContain("更自然的表达");
    expect(source).toContain("你的表达");
    expect(source).toContain("更自然的说法");
    expect(source).toContain("原句不一定是错的");
    expect(source).toContain("onClick={() => onPlay(item.improved)}");
    expect(source).toContain("onClick={() => onReadAloud(item.improved)}");
    expect(source).not.toContain("修改建议");
    expect(source).not.toContain("原句，需要修改的部分已标记：");
    expect(source).not.toContain("需修改：");
    expect(source).not.toContain("这次没有必须修改的表达");
  });

  test("keeps three suggestions readable through legacy browser persistence and export schemas", () => {
    const review = { suggestions: [legacySuggestion(1), legacySuggestion(2), legacySuggestion(3)] };
    const messages = legacyMessages();

    expect(
      sessionSchema.safeParse({
        id: "conversation-legacy-review",
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
        phase: "review",
        storyZh: "今天回家。",
        messages,
        review,
      }).success,
    ).toBe(true);
    expect(
      storyExportSessionSchema.safeParse({
        id: "conversation-legacy-export",
        updatedAt: "2026-08-10T00:00:00.000Z",
        phase: "review",
        storyZh: "今天回家。",
        messages,
        review,
      }).success,
    ).toBe(true);
  });
});
