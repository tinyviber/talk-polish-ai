import { describe, expect, test } from "bun:test";
import type { DailyStoryHistoryMessage, DailyStoryReviewRubric } from "@kotoba/contracts";
import {
  calculateReviewScore,
  dailyStoryReviewComment,
  normalizeReviewDiff,
  normalizeReviewRubric,
  normalizeReviewSuggestions,
  selectReviewHistory,
  selectReviewSourceTurns,
} from "./review";

function rubric(scores = { fluency: 70, grammar: 70, vocabulary: 70, naturalness: 70 }) {
  return Object.fromEntries(
    Object.entries(scores).map(([dimension, score]) => [
      dimension,
      { score, comment: `${dimension} 客观短评`, evidence: [] },
    ]),
  ) as unknown as DailyStoryReviewRubric;
}

describe("daily story review domain", () => {
  test("selects recent user history within the review character budget", () => {
    const history: DailyStoryHistoryMessage[] = [
      { id: "a1", role: "assistant", text: "ignore me" },
      { id: "u1", role: "user", source: "typed", text: "first" },
      { id: "u2", role: "user", source: "asr", text: "second" },
    ];

    expect(selectReviewSourceTurns(history)).toEqual(
      new Map([
        ["u1", "first"],
        ["u2", "second"],
      ]),
    );
    expect(selectReviewHistory(history)).toEqual([
      { id: "u1", text: "first" },
      { id: "u2", text: "second" },
    ]);
  });

  test("keeps only evidence quoted from submitted source turns", () => {
    const result = normalizeReviewRubric(
      {
        ...rubric(),
        grammar: {
          score: 70,
          comment: "需要继续练习。",
          evidence: [
            { sourceTurnId: "u1", quote: "was long" },
            { sourceTurnId: "u1", quote: "invented" },
            { sourceTurnId: "unknown", quote: "was long" },
          ],
        },
      },
      new Map([["u1", "The meeting was long."]]),
    );

    expect(result.rubric.grammar.evidence).toEqual([{ sourceTurnId: "u1", quote: "was long" }]);
    expect(result.skippedEvidence).toEqual([
      { dimension: "grammar", sourceTurnId: "u1", reason: "quote_not_in_source" },
      { dimension: "grammar", sourceTurnId: "unknown", reason: "unknown_source_turn" },
    ]);
  });

  test("accepts only source-reconstructing diffs and one suggestion per turn", () => {
    const sourceTurns = new Map([["u1", "The meeting was long."]]);
    expect(
      normalizeReviewDiff("The meeting was long.", [
        ["=", "The meeting "],
        ["-", "was"],
        ["=", " long."],
      ]),
    ).toEqual([
      ["=", "The meeting "],
      ["-", "was"],
      ["=", " long."],
    ]);
    expect(normalizeReviewDiff("The meeting was long.", [["-", "wrong"]])).toBeNull();

    const result = normalizeReviewSuggestions(
      [
        {
          sourceTurnId: "u1",
          diff: [["-", "The meeting was long."]],
          improved: "The meeting took too long.",
          category: "naturalness",
          explanationZh: "更自然。",
        },
        {
          sourceTurnId: "u1",
          diff: [["-", "The meeting was long."]],
          improved: "It was a long meeting.",
          category: "clarity",
          explanationZh: "更清楚。",
        },
      ],
      sourceTurns,
    );
    expect(result.suggestions).toEqual([
      {
        sourceTurnId: "u1",
        original: "The meeting was long.",
        diff: [["-", "The meeting was long."]],
        improved: "The meeting took too long.",
        category: "naturalness",
        explanationZh: "更自然。",
      },
    ]);
    expect(result.skippedSuggestions).toEqual([
      { sourceTurnId: "u1", reason: "duplicate_source_turn" },
    ]);
  });

  test("calculates score and preserves the existing comment bands", () => {
    expect(
      calculateReviewScore(rubric({ fluency: 91, grammar: 80, vocabulary: 70, naturalness: 60 })),
    ).toBe(75);
    expect(dailyStoryReviewComment(95)).toBe("本次表达整体清晰自然，可继续扩大表达范围。");
    expect(dailyStoryReviewComment(75)).toBe("本次表达整体稳定，针对细节继续打磨会更自然。");
    expect(dailyStoryReviewComment(60)).toBe("本次表达基本清楚，继续针对分项薄弱处练习。");
    expect(dailyStoryReviewComment(59)).toBe(
      "本次表达基础仍需加强，建议优先结合四项分项反馈练习。",
    );
  });
});
