import { describe, expect, test } from "vitest";
import { reviewOriginalDiffSegments } from "./review-diff";

describe("Daily Story review diff display", () => {
  test("renders server diff operations as kept and deleted segments", () => {
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

  test("uses a deterministic fallback for old suggestions without diff", () => {
    const segments = reviewOriginalDiffSegments({
      original: "I go home.",
      improved: "I went home.",
    });
    expect(segments.some((segment) => segment.deleted && segment.text.includes("go"))).toBe(true);
    expect(segments.some((segment) => !segment.deleted && segment.text.includes("I"))).toBe(true);
  });

  test("does not mark an unreliable whole-sentence fallback as deleted", () => {
    expect(
      reviewOriginalDiffSegments({ original: "Completely unrelated.", improved: "Another idea." }),
    ).toEqual([{ key: "ordinary-0", text: "Completely unrelated.", deleted: false }]);
  });

  test("falls back when a stored diff is malformed", () => {
    const segments = reviewOriginalDiffSegments({
      original: "I go home.",
      improved: "I went home.",
      diff: [["=", "not the original"]],
    });
    expect(segments.some((segment) => segment.deleted)).toBe(true);
  });

  test("marks changed punctuation when old data has no server diff", () => {
    const segments = reviewOriginalDiffSegments({
      original: "Hello.",
      improved: "Hello!",
    });
    expect(segments).toContainEqual({ key: "segment-1", text: ".", deleted: true });
  });
});
