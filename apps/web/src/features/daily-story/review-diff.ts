import { dailyStoryReviewDiffSchema, type DailyStoryReviewDiffSegment } from "@kotoba/contracts";

export type ReviewDiffDisplaySegment = {
  key: string;
  text: string;
  deleted: boolean;
};

type DiffInput = {
  original: string;
  improved: string;
  diff?: DailyStoryReviewDiffSegment[];
};

export function isValidReviewDiff(
  original: string,
  diff: unknown,
): diff is DailyStoryReviewDiffSegment[] {
  const parsed = dailyStoryReviewDiffSchema.safeParse(diff);
  if (parsed.success) return isDisplayableDiff(original, parsed.data);
  const legacy = parseLegacyDiff(diff);
  return legacy !== null && isDisplayableDiff(original, legacy);
}

export function reviewOriginalDiffSegments(input: DiffInput): ReviewDiffDisplaySegment[] {
  if (isValidReviewDiff(input.original, input.diff)) {
    return input.diff.map(([operation, text], index) => ({
      key: `diff-${index}`,
      text,
      deleted: operation === "-",
    }));
  }
  return [{ key: "ordinary-0", text: input.original, deleted: false }];
}

function isDisplayableDiff(original: string, diff: DailyStoryReviewDiffSegment[]) {
  return (
    hasReliableKeptSpan(original, diff) &&
    diff.some(([operation]) => operation === "-") &&
    diff.map(([, text]) => text).join("") === original
  );
}

function hasReliableKeptSpan(original: string, diff: DailyStoryReviewDiffSegment[]) {
  const keptText = diff
    .filter(([operation]) => operation === "=")
    .map(([, text]) => text)
    .join("");
  return (
    keptText.length >= Math.max(1, Math.ceil(original.length * 0.2)) &&
    /[\p{L}\p{N}]/u.test(keptText)
  );
}

/** Read explicit legacy diffs without reviving heuristic LCS fallback. */
function parseLegacyDiff(value: unknown): DailyStoryReviewDiffSegment[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    !value.every(
      (segment) =>
        Array.isArray(segment) &&
        segment.length === 2 &&
        (segment[0] === "=" || segment[0] === "-") &&
        typeof segment[1] === "string" &&
        segment[1].length > 0,
    )
  ) {
    return null;
  }
  return value as DailyStoryReviewDiffSegment[];
}
