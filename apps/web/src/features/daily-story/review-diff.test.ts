import { describe, expect, test } from "vitest";
import { reviewOriginalDiffSegments } from "./review-diff";

describe("Daily Story review diff display", () => {
  test("keeps valid stored diffs backward-compatible", () => {
    expect(
      reviewOriginalDiffSegments({
        original: "I go home.",
        improved: "I went home.",
        diff: [
          ["=", "I "],
          ["-", "go"],
          ["=", " home."],
        ],
      }),
    ).toEqual([
      { key: "diff-0", text: "I ", deleted: false },
      { key: "diff-1", text: "go", deleted: true },
      { key: "diff-2", text: " home.", deleted: false },
    ]);
  });

  test.each([
    {
      label: "missing diff",
      original: "I go home.",
      diff: undefined,
    },
    {
      label: "malformed diff",
      original: "I go home.",
      diff: [["=", "not the original"]],
    },
    {
      label: "diff without a minus segment",
      original: "I go home.",
      diff: [["=", "I go home."]],
    },
    {
      label: "deletion-only full recast",
      original: "I go home.",
      diff: [["-", "I go home."]],
    },
    {
      label: "negligible kept word",
      original: "I went home.",
      diff: [
        ["=", "I"],
        ["-", " went home."],
      ],
    },
    {
      label: "whitespace-only kept span",
      original: " I went home.",
      diff: [
        ["=", " "],
        ["-", "I went home."],
      ],
    },
    {
      label: "non-reconstructing diff",
      original: "I go home.",
      diff: [["-", "wrong"]],
    },
  ])("returns exactly the original without strike-through for $label", ({ original, diff }) => {
    expect(
      reviewOriginalDiffSegments({
        original,
        improved: "A substantially different natural recast.",
        diff: diff as never,
      }),
    ).toEqual([{ key: "ordinary-0", text: original, deleted: false }]);
  });

  test("keeps explicit legacy diffs readable without heuristic fallback", () => {
    const adjacent = reviewOriginalDiffSegments({
      original: "I go home.",
      improved: "I went home.",
      diff: [
        ["=", "I"],
        ["=", " go"],
        ["-", " home."],
      ],
    });
    expect(adjacent.some((segment) => segment.deleted)).toBe(true);

    const overLimitOriginal = "a".repeat(33);
    const overLimit = reviewOriginalDiffSegments({
      original: overLimitOriginal,
      improved: "A recast.",
      diff: Array.from({ length: 33 }, (_, index) => [index % 2 ? "=" : "-", "a"]),
    });
    expect(overLimit.some((segment) => segment.deleted)).toBe(true);
  });
});
