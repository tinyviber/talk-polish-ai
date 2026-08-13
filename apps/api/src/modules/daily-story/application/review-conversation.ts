import type { DailyStoryChatConfig, DailyStoryHistoryMessage } from "@kotoba/contracts";
import { dailyStoryValidation } from "./errors";
import { createStructuredGenerator } from "../../../capabilities/structured-generator";
import { reviewResultSchema, reviewSystemPrompt, reviewUserPrompt } from "../policy";
import {
  calculateReviewScore,
  dailyStoryReviewComment,
  normalizeReviewRubric,
  normalizeReviewSuggestions,
  selectReviewHistory,
  selectReviewSourceTurns,
} from "../domain/review";
import { DailyStoryProviderNotConfiguredError } from "./ports";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  ProbedTextModel,
  SafeProviderCall,
} from "./ports";

export const DAILY_STORY_REVIEW_MAX_TOKENS = 1536;

const REVIEW_REPAIR_INSTRUCTION =
  "Return only JSON with the exact rubric and suggestions shape from the system instruction. Even when there are no useful improvements, include the complete rubric with fluency, grammar, vocabulary, and naturalness, and set only suggestions to []. Never omit rubric. Do not return a total score or top-level comment. Each evidence quote must be an exact continuous substring of its referenced user turn.";

export type ReviewChatProviderFactory = DailyStoryProviderFactory;
export type ReviewConversationGuard = DailyStoryGuard;

export type ReviewConversationInput = {
  learnerId: string;
  ip?: string;
  requestId: string;
  storyZh: string;
  history: DailyStoryHistoryMessage[];
  chat: DailyStoryChatConfig;
};

export type ReviewConversationPolicy = {
  resultSchema: typeof reviewResultSchema;
  systemPrompt: string;
  userPrompt: typeof reviewUserPrompt;
  repairInstruction: string;
  maxTokens: number;
};

export const reviewConversationPolicy: ReviewConversationPolicy = {
  resultSchema: reviewResultSchema,
  systemPrompt: reviewSystemPrompt,
  userPrompt: reviewUserPrompt,
  repairInstruction: REVIEW_REPAIR_INSTRUCTION,
  maxTokens: DAILY_STORY_REVIEW_MAX_TOKENS,
};

export function createReviewConversation(dependencies: {
  config: DailyStoryRuntimeConfig;
  providerFactory: ReviewChatProviderFactory;
  guard: ReviewConversationGuard;
  safeProviderCall: SafeProviderCall;
  policy: ReviewConversationPolicy;
}) {
  return async function review(input: ReviewConversationInput) {
    return dependencies.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "review",
      perMinute: dependencies.config.dailyStoryRateLimitPerMinute,
      concurrent: dependencies.config.dailyStoryConcurrentRequests,
      run: async () => {
        const sourceTurns = selectReviewSourceTurns(input.history);
        if (sourceTurns.size === 0) {
          throw dailyStoryValidation("Conversation needs a user turn before review.");
        }
        const reviewHistory = selectReviewHistory(input.history);
        const generated = await dependencies.safeProviderCall(() => {
          const chat = required(dependencies.providerFactory({ chat: input.chat }).chat);
          return createStructuredGenerator(chat).generate({
            schema: dependencies.policy.resultSchema,
            repairInstruction: dependencies.policy.repairInstruction,
            messages: [
              { role: "system", content: dependencies.policy.systemPrompt },
              {
                role: "user",
                content: dependencies.policy.userPrompt({
                  storyZh: input.storyZh,
                  history: reviewHistory,
                }),
              },
            ],
            requestId: input.requestId,
            maxTokens: dependencies.policy.maxTokens,
          });
        }, input.requestId);
        const suggestions = normalizeReviewSuggestions(generated.value.suggestions, sourceTurns);
        for (const skipped of suggestions.skippedSuggestions) {
          console.warn("[daily-story review suggestion skipped]", {
            requestId: input.requestId,
            reason: skipped.reason,
          });
        }
        for (const fallback of suggestions.diffFallbacks) {
          console.warn("[daily-story review diff fallback]", {
            requestId: input.requestId,
            sourceTurnId: fallback.sourceTurnId,
            originalChars: fallback.originalChars,
            diffSegments: fallback.diffSegments,
          });
        }
        const rubric = normalizeReviewRubric(generated.value.rubric, sourceTurns);
        for (const skipped of rubric.skippedEvidence) {
          console.warn("[daily-story review evidence skipped]", {
            requestId: input.requestId,
            dimension: skipped.dimension,
            reason: skipped.reason,
          });
        }
        const score = calculateReviewScore(rubric.rubric);
        return {
          score,
          comment: dailyStoryReviewComment(score),
          rubric: rubric.rubric,
          suggestions: suggestions.suggestions,
        };
      },
    });
  };
}

function required(value: ProbedTextModel | undefined) {
  if (!value) throw new DailyStoryProviderNotConfiguredError();
  return value;
}
