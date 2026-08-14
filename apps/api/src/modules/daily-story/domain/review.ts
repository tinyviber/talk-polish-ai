import {
  dailyStoryReviewDiffSchema,
  type DailyStoryHistoryMessage,
  type DailyStoryReviewDiffSegment,
  type DailyStoryReviewEvidence,
  type DailyStoryReviewRubric,
  type DailyStoryReviewSuggestion,
  type DailyStoryReviewCategory,
} from "@kotoba/contracts";

export const DAILY_STORY_REVIEW_HISTORY_CHARS = 12_000;
export const DAILY_STORY_REVIEW_CONVERSATION_CHARS = 12_000;
export const DAILY_STORY_REVIEW_MAX_SUGGESTIONS = 2;

type ReviewUserTurn = Extract<DailyStoryHistoryMessage, { role: "user" }>;

export type ReviewSuggestionCandidate = {
  sourceTurnId: string;
  diff?: unknown;
  improved: string;
  category: DailyStoryReviewCategory;
  explanationZh: string;
};

export function normalizeReviewSuggestionCandidate(
  value: unknown,
): ReviewSuggestionCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const category = candidate.category;
  if (
    typeof candidate.sourceTurnId !== "string" ||
    candidate.sourceTurnId.length === 0 ||
    typeof candidate.improved !== "string" ||
    candidate.improved.length === 0 ||
    (category !== "clarity" && category !== "grammar" && category !== "naturalness") ||
    typeof candidate.explanationZh !== "string" ||
    candidate.explanationZh.length === 0
  ) {
    return null;
  }
  return {
    sourceTurnId: candidate.sourceTurnId,
    diff: candidate.diff,
    improved: candidate.improved,
    category,
    explanationZh: candidate.explanationZh,
  };
}

export type ReviewEvidenceIssue = {
  sourceTurnId: string;
  reason: "unknown_source_turn" | "quote_not_in_source";
};

export type ReviewRubricNormalization = {
  rubric: DailyStoryReviewRubric;
  skippedEvidence: Array<ReviewEvidenceIssue & { dimension: string }>;
};

export type ReviewSuggestionNormalization = {
  suggestions: DailyStoryReviewSuggestion[];
  skippedSuggestions: Array<{
    sourceTurnId: string;
    reason: "unknown_source_turn" | "duplicate_source_turn";
  }>;
  diffFallbacks: Array<{
    sourceTurnId: string;
    originalChars: number;
    diffSegments: number | null;
  }>;
};

export function selectReviewSourceTurns(history: DailyStoryHistoryMessage[]) {
  return new Map(
    history
      .filter((message): message is ReviewUserTurn => message.role === "user")
      .map((message) => [message.id, message.text]),
  );
}

export function selectReviewHistory(history: DailyStoryHistoryMessage[]) {
  const userTurns = history
    .filter((message): message is ReviewUserTurn => message.role === "user")
    .map(({ id, text }) => ({ id, text }));
  const selected: Array<{ id: string; text: string }> = [];
  let chars = 0;
  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const turn = userTurns[index]!;
    if (chars > 0 && chars + turn.text.length > DAILY_STORY_REVIEW_HISTORY_CHARS) continue;
    selected.unshift(turn);
    chars += turn.text.length;
    if (chars >= DAILY_STORY_REVIEW_HISTORY_CHARS) break;
  }
  return selected;
}

/** Bounded role-aware context for overview only. */
export function selectReviewConversation(history: DailyStoryHistoryMessage[]) {
  const selected: DailyStoryHistoryMessage[] = [];
  let chars = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (chars > 0 && chars + message.text.length > DAILY_STORY_REVIEW_CONVERSATION_CHARS) continue;
    selected.unshift(message);
    chars += message.text.length;
    if (chars >= DAILY_STORY_REVIEW_CONVERSATION_CHARS) break;
  }
  return selected.map((message) =>
    message.role === "user"
      ? { id: message.id, role: "user" as const, source: message.source, text: message.text }
      : { id: message.id, role: "assistant" as const, text: message.text },
  );
}

export function normalizeReviewEvidence(
  evidence: readonly DailyStoryReviewEvidence[],
  sourceTurns: ReadonlyMap<string, string>,
) {
  const skippedEvidence: ReviewEvidenceIssue[] = [];
  const normalized = evidence.filter((item) => {
    const source = sourceTurns.get(item.sourceTurnId);
    const valid = source !== undefined && source.includes(item.quote);
    if (!valid) {
      skippedEvidence.push({
        sourceTurnId: item.sourceTurnId,
        reason: source === undefined ? "unknown_source_turn" : "quote_not_in_source",
      });
    }
    return valid;
  });
  return { evidence: normalized, skippedEvidence };
}

export function normalizeReviewRubric(
  rubric: DailyStoryReviewRubric,
  sourceTurns: ReadonlyMap<string, string>,
): ReviewRubricNormalization {
  const skippedEvidence: ReviewRubricNormalization["skippedEvidence"] = [];
  const normalized = Object.fromEntries(
    Object.entries(rubric).map(([dimension, item]) => {
      const result = normalizeReviewEvidence(item.evidence, sourceTurns);
      skippedEvidence.push(...result.skippedEvidence.map((issue) => ({ ...issue, dimension })));
      return [dimension, { ...item, evidence: result.evidence }];
    }),
  ) as DailyStoryReviewRubric;
  return { rubric: normalized, skippedEvidence };
}

export function normalizeReviewDiff(
  original: string,
  diff: unknown,
): DailyStoryReviewDiffSegment[] | null {
  const parsed = dailyStoryReviewDiffSchema.safeParse(diff);
  if (!parsed.success) return null;
  const reconstructed = parsed.data.map(([, text]) => text).join("");
  return reconstructed === original ? parsed.data : null;
}

export function normalizeReviewSuggestions(
  suggestions: readonly ReviewSuggestionCandidate[],
  sourceTurns: ReadonlyMap<string, string>,
): ReviewSuggestionNormalization {
  const skippedSuggestions: ReviewSuggestionNormalization["skippedSuggestions"] = [];
  const diffFallbacks: ReviewSuggestionNormalization["diffFallbacks"] = [];
  const seenSourceIds = new Set<string>();
  const normalized: DailyStoryReviewSuggestion[] = [];

  for (const suggestion of suggestions.slice(0, DAILY_STORY_REVIEW_MAX_SUGGESTIONS)) {
    const original = sourceTurns.get(suggestion.sourceTurnId);
    if (original === undefined) {
      skippedSuggestions.push({
        sourceTurnId: suggestion.sourceTurnId,
        reason: "unknown_source_turn",
      });
      continue;
    }
    if (seenSourceIds.has(suggestion.sourceTurnId)) {
      skippedSuggestions.push({
        sourceTurnId: suggestion.sourceTurnId,
        reason: "duplicate_source_turn",
      });
      continue;
    }
    seenSourceIds.add(suggestion.sourceTurnId);
    const diff = normalizeReviewDiff(original, suggestion.diff);
    if (diff === null) {
      diffFallbacks.push({
        sourceTurnId: suggestion.sourceTurnId,
        originalChars: original.length,
        diffSegments: Array.isArray(suggestion.diff) ? suggestion.diff.length : null,
      });
    }
    normalized.push({
      sourceTurnId: suggestion.sourceTurnId,
      original,
      improved: suggestion.improved,
      category: suggestion.category,
      explanationZh: suggestion.explanationZh,
      ...(diff ? { diff } : {}),
    });
  }

  return { suggestions: normalized, skippedSuggestions, diffFallbacks };
}

export function calculateReviewScore(rubric: DailyStoryReviewRubric) {
  return Math.round(
    (rubric.fluency.score +
      rubric.grammar.score +
      rubric.vocabulary.score +
      rubric.naturalness.score) /
      4,
  );
}

export function dailyStoryReviewComment(score: number) {
  if (score >= 90) return "本次表达整体清晰自然，可继续扩大表达范围。";
  if (score >= 75) return "本次表达整体稳定，针对细节继续打磨会更自然。";
  if (score >= 60) return "本次表达基本清楚，继续针对分项薄弱处练习。";
  return "本次表达基础仍需加强，建议优先结合四项分项反馈练习。";
}
