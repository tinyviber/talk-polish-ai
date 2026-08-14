import { z } from "zod";

export const faithfulTranscriptChangeCategorySchema = z.enum([
  "homophone",
  "punctuation",
  "segmentation",
  "capitalization",
]);
export type FaithfulTranscriptChangeCategory = z.infer<
  typeof faithfulTranscriptChangeCategorySchema
>;

export const faithfulTranscriptChangeSchema = z
  .object({
    category: faithfulTranscriptChangeCategorySchema,
    from: z.string().min(1).max(80).optional(),
    to: z.string().min(1).max(80).optional(),
  })
  .strict();
export type FaithfulTranscriptChange = z.infer<typeof faithfulTranscriptChangeSchema>;

export const faithfulTranscriptModelResultSchema = z
  .object({
    normalizedText: z.string().min(1).max(2_000),
    changes: z.array(faithfulTranscriptChangeSchema).max(24),
  })
  .strict();
export type FaithfulTranscriptModelResult = z.infer<typeof faithfulTranscriptModelResultSchema>;

export const faithfulTranscriptResponseSchema = z
  .object({
    transcript: z.string().max(2_000),
    rawTranscript: z.string().max(2_000).optional(),
    normalizedTranscript: z.string().max(2_000).optional(),
    changes: z.array(faithfulTranscriptChangeSchema).max(24).optional(),
    requestId: z.string().min(1),
  })
  .strict();
export type FaithfulTranscriptResponse = z.infer<typeof faithfulTranscriptResponseSchema>;

export type FaithfulTranscriptValidation = {
  normalizedText: string;
  changes: FaithfulTranscriptChange[];
};

type WordToken = { value: string; normalized: string; start: number; end: number };

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+|[-‑][\p{L}\p{N}]+)*/gu;

/**
 * Application-side guard for faithful ASR cleanup. It deliberately compares
 * lexical tokens before allowing any formatting change, so a polishing model
 * cannot insert, delete, reorder, or replace phrases.
 */
export function validateFaithfulTranscript(
  rawTranscript: string,
  candidate: unknown,
): FaithfulTranscriptValidation | null {
  const parsed = faithfulTranscriptModelResultSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const raw = rawTranscript.normalize("NFKC");
  const normalized = parsed.data.normalizedText.normalize("NFKC");
  if (!raw.trim() || !normalized.trim()) return null;
  if (normalized.length > 2_000) return null;

  const rawWords = tokenize(raw);
  const normalizedWords = tokenize(normalized);
  if (rawWords.length !== normalizedWords.length) return null;

  const changes: FaithfulTranscriptChange[] = [];
  for (let index = 0; index < rawWords.length; index += 1) {
    const source = rawWords[index]!;
    const target = normalizedWords[index]!;
    if (source.normalized === target.normalized) continue;
    if (!isAllowedHomophone(source.normalized, target.normalized, rawWords, index)) return null;
    changes.push({ category: "homophone", from: source.value, to: target.value });
  }

  const derivedCategories = new Set<FaithfulTranscriptChangeCategory>(
    changes.map((item) => item.category),
  );
  if (raw !== normalized) {
    if (
      rawWords.length === normalizedWords.length &&
      rawWords.every((word, index) => word.normalized === normalizedWords[index]!.normalized)
    ) {
      derivedCategories.add("punctuation");
      if (hasCapitalizationOnlyDifference(raw, normalized)) derivedCategories.add("capitalization");
      if (hasSegmentationDifference(raw, normalized)) derivedCategories.add("segmentation");
    }
  }

  const declared = parsed.data.changes;
  const declaredCategories = new Set(declared.map((item) => item.category));
  if (
    [...derivedCategories].some(
      (category) => category === "homophone" && !declaredCategories.has(category),
    )
  )
    return null;
  if (declared.some((item) => !derivedCategories.has(item.category))) return null;
  if (
    changes.length > 0 &&
    declared.some(
      (item) =>
        item.category === "homophone" &&
        item.from &&
        item.to &&
        !changes.some((change) => change.from === item.from && change.to === item.to),
    )
  )
    return null;

  return {
    normalizedText: parsed.data.normalizedText,
    changes: [...changes, ...deriveFormattingChanges(raw, normalized, derivedCategories)],
  };
}

function tokenize(value: string): WordToken[] {
  return [...value.matchAll(WORD_RE)].map((match) => {
    const value = match[0]!;
    const start = match.index ?? 0;
    return { value, normalized: normalizeWord(value), start, end: start + value.length };
  });
}

function normalizeWord(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("’", "'")
    .replaceAll("‑", "-");
}

function isAllowedHomophone(source: string, target: string, words: WordToken[], index: number) {
  if (source !== "sea" || target !== "see") return false;
  const previous = words[index - 1]?.normalized;
  const beforePrevious = words[index - 2]?.normalized;
  const next = words[index + 1]?.normalized;
  if (previous !== "to" || !next) return false;
  // Only an intentional-vision verb followed by an unambiguous object can
  // disambiguate sea/see. Motion, travel, and location contexts stay raw.
  if (
    ![
      "want",
      "wants",
      "wanted",
      "need",
      "needs",
      "needed",
      "hope",
      "hopes",
      "hoped",
      "plan",
      "plans",
      "planned",
      "try",
      "tries",
      "tried",
      "like",
      "likes",
      "liked",
      "love",
      "loves",
      "loved",
    ].includes(beforePrevious ?? "")
  )
    return false;

  if (["you", "him", "her", "them", "us"].includes(next)) return true;
  // A possessive or indefinite article must be followed by an object noun.
  // Deliberately reject "the ..." because it is commonly a location/sea
  // reading (and must not turn into a target-text correction).
  return (
    ["my", "your", "his", "her", "our", "their", "a", "an"].includes(next) &&
    Boolean(words[index + 2]?.normalized)
  );
}

function hasCapitalizationOnlyDifference(raw: string, normalized: string) {
  return raw.replace(/[A-Za-z]/g, "a") === normalized.replace(/[A-Za-z]/g, "a");
}

function hasSegmentationDifference(raw: string, normalized: string) {
  return (
    raw.replace(/[^\p{L}\p{N}]+/gu, " ").trim() !==
    normalized.replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  );
}

function deriveFormattingChanges(
  raw: string,
  normalized: string,
  categories: Set<FaithfulTranscriptChangeCategory>,
) {
  return [...categories]
    .filter((category) => category !== "homophone")
    .map((category) => ({ category }));
}
