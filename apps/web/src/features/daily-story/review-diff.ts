import type { DailyStoryReviewDiffSegment } from "@kotoba/contracts";

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
  diff: DailyStoryReviewDiffSegment[] | undefined,
): diff is DailyStoryReviewDiffSegment[] {
  return (
    Array.isArray(diff) &&
    diff.length > 0 &&
    diff.some(([operation]) => operation === "-") &&
    diff.every(
      (segment) =>
        Array.isArray(segment) &&
        segment.length === 2 &&
        (segment[0] === "=" || segment[0] === "-") &&
        typeof segment[1] === "string" &&
        segment[1].length > 0,
    ) &&
    diff.map(([, text]) => text).join("") === original
  );
}

export function reviewOriginalDiffSegments(input: DiffInput): ReviewDiffDisplaySegment[] {
  if (isValidReviewDiff(input.original, input.diff)) {
    return input.diff.map(([operation, text], index) => ({
      key: `diff-${index}`,
      text,
      deleted: operation === "-",
    }));
  }
  return fallbackSegments(input.original, input.improved);
}

function fallbackSegments(original: string, improved: string): ReviewDiffDisplaySegment[] {
  const tokens = tokenize(original);
  const improvedTokens = tokenize(improved);
  const tokenPairs = lcsPairs(
    tokens.map((token) => token.text),
    improvedTokens.map((token) => token.text),
  );
  const tokenResult = tokenPairs.length
    ? segmentsFromTokens(tokens, new Set(tokenPairs.map(([index]) => index)))
    : [];
  if (isReliableFallback(tokenResult, tokenPairs.length > 0)) return tokenResult;

  const chars = [...original];
  const improvedChars = [...improved];
  const charPairs = lcsPairs(chars, improvedChars);
  const matched = new Set(charPairs.map(([index]) => index));
  const longestRun = charPairs.reduce((best, pair, index) => {
    const previous = charPairs[index - 1];
    return previous && pair[0] === previous[0] + 1 && pair[1] === previous[1] + 1
      ? Math.max(best, 2)
      : Math.max(best, 1);
  }, 0);
  const charResult = mergeSegments(
    chars.map((text, index) => ({
      key: `fallback-char-${index}`,
      text,
      deleted: !matched.has(index) && isMeaningful(text),
    })),
  );
  return longestRun >= 2 && isReliableFallback(charResult, true) ? charResult : ordinary(original);
}

function tokenize(value: string) {
  const result: Array<{ text: string; meaningful: boolean }> = [];
  for (const match of value.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s]/gu)) {
    const text = match[0];
    if (text) result.push({ text, meaningful: isMeaningful(text) });
  }
  return result;
}

function segmentsFromTokens(
  tokens: Array<{ text: string; meaningful: boolean }>,
  kept: Set<number>,
) {
  return mergeSegments(
    tokens.map((token, index) => ({
      key: `fallback-token-${index}`,
      text: token.text,
      deleted: token.meaningful && !kept.has(index),
    })),
  );
}

function isReliableFallback(segments: ReviewDiffDisplaySegment[], hasCommon: boolean) {
  return (
    hasCommon &&
    segments.some((segment) => !segment.deleted && isWordLike(segment.text)) &&
    segments.some((segment) => segment.deleted && isMeaningful(segment.text))
  );
}

function mergeSegments(segments: ReviewDiffDisplaySegment[]) {
  const merged: ReviewDiffDisplaySegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.deleted === segment.deleted) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment, key: `segment-${merged.length}` });
    }
  }
  return merged;
}

function ordinary(text: string): ReviewDiffDisplaySegment[] {
  return [{ key: "ordinary-0", text, deleted: false }];
}

function isMeaningful(text: string) {
  return /\S/u.test(text);
}

function isWordLike(text: string) {
  return /[\p{L}\p{N}_]/u.test(text);
}

function lcsPairs(left: string[], right: string[]): Array<[number, number]> {
  const table = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row]![column] =
        left[row] === right[column]
          ? table[row + 1]![column + 1]! + 1
          : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      pairs.push([row, column]);
      row += 1;
      column += 1;
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) row += 1;
    else column += 1;
  }
  return pairs;
}
