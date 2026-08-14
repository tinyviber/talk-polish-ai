import {
  faithfulTranscriptModelResultSchema,
  validateFaithfulTranscript,
  type DailyStoryChatConfig,
  type DailyStoryNormalizationHistory,
} from "@kotoba/contracts";
import { createStructuredGenerator } from "../../../capabilities/structured-generator";
import {
  faithfulTranscriptSystemPrompt,
  faithfulTranscriptUserPrompt,
  FAITHFUL_TRANSCRIPT_MAX_TOKENS,
} from "../policy";
import { DailyStoryProviderNotConfiguredError } from "./ports";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export type TranscriptNormalizationResult = {
  rawTranscript: string;
  normalizedTranscript: string;
  changes: Array<{
    category: "homophone" | "punctuation" | "segmentation" | "capitalization";
    from?: string;
    to?: string;
  }>;
  transcript: string;
};

export type TranscriptNormalizationInput = {
  rawTranscript: string;
  storyZh?: string;
  recentHistory?: DailyStoryNormalizationHistory;
  chat?: DailyStoryChatConfig;
  requestId: string;
};

export function createFaithfulTranscriptNormalizer(deps: {
  providers: DailyStoryProviderFactory;
  safeProviderCall: SafeProviderCall;
}) {
  return async function normalize(
    input: TranscriptNormalizationInput,
  ): Promise<TranscriptNormalizationResult> {
    const fallback = rawResult(input.rawTranscript);
    if (!input.chat || !input.rawTranscript.trim()) return fallback;
    try {
      const generated = await deps.safeProviderCall(() => {
        const chat = deps.providers({ chat: input.chat }).chat;
        if (!chat) throw new DailyStoryProviderNotConfiguredError();
        return createStructuredGenerator(chat).generate({
          schema: faithfulTranscriptModelResultSchema,
          messages: [
            { role: "system", content: faithfulTranscriptSystemPrompt },
            {
              role: "user",
              content: faithfulTranscriptUserPrompt({
                rawTranscript: input.rawTranscript,
                ...(input.storyZh ? { storyZh: input.storyZh } : {}),
                ...(input.recentHistory ? { recentHistory: input.recentHistory } : {}),
              }),
            },
          ],
          requestId: input.requestId,
          maxTokens: FAITHFUL_TRANSCRIPT_MAX_TOKENS,
        });
      }, input.requestId);
      const validated = validateFaithfulTranscript(input.rawTranscript, generated.value);
      if (!validated) return fallback;
      return {
        rawTranscript: input.rawTranscript,
        normalizedTranscript: validated.normalizedText,
        changes: validated.changes,
        transcript: validated.normalizedText,
      };
    } catch {
      // Normalization is an enhancement. ASR success must survive every model
      // failure, including provider setup, timeout, repair, and abort errors.
      return fallback;
    }
  };
}

export function createNormalizeTranscript(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  const normalize = createFaithfulTranscriptNormalizer(deps);
  return (input: {
    learnerId: string;
    ip?: string;
    requestId: string;
    rawTranscript: string;
    storyZh?: string;
    recentHistory?: DailyStoryNormalizationHistory;
    chat?: DailyStoryChatConfig;
  }) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "asr-normalization",
      perMinute: deps.config.dailyStoryRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: () => normalize(input),
    });
}

export function rawResult(rawTranscript: string): TranscriptNormalizationResult {
  return {
    rawTranscript,
    normalizedTranscript: rawTranscript,
    changes: [],
    transcript: rawTranscript,
  };
}
