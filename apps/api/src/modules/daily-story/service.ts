import { createCheckProvider } from "./application/check-provider";
import { createReplyToTurn } from "./application/reply-to-turn";
import { createStartConversation } from "./application/start-conversation";
import { createSynthesizeSpeech } from "./application/synthesize-speech";
import { createTranscribeAudio } from "./application/transcribe-audio";
import { createNormalizeTranscript } from "./application/normalize-transcript";
import {
  createReviewConversation,
  reviewConversationPolicy,
  type ReviewConversationInput,
} from "./application/review-conversation";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./application/ports";

export type DailyStoryApplicationDependencies = {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
};

export const DAILY_STORY_REPLY_MAX_TOKENS = 512;
export { DAILY_STORY_REVIEW_MAX_TOKENS } from "./application/review-conversation";
export { dailyStoryReviewComment } from "./domain/review";

/** Pure application facade. Provider construction and HTTP composition live in index.ts. */
export function createDailyStoryService(dependencies: DailyStoryApplicationDependencies) {
  const common = {
    config: dependencies.config,
    providers: dependencies.providers,
    guard: dependencies.guard,
    safeProviderCall: dependencies.safeProviderCall,
  };

  return {
    start: createStartConversation(common),
    transcribe: createTranscribeAudio(common),
    normalizeTranscript: createNormalizeTranscript(common),
    reply: createReplyToTurn(common),
    review: createReviewConversation({
      ...common,
      providerFactory: dependencies.providers,
      policy: reviewConversationPolicy,
    }),
    tts: createSynthesizeSpeech(common),
    providerCheck: createCheckProvider(common),
  };
}

export type DailyStoryService = ReturnType<typeof createDailyStoryService>;
export type { ReviewConversationInput } from "./application/review-conversation";
