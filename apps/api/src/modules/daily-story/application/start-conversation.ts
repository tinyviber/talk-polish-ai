import { randomUUID } from "node:crypto";
import type { DailyStoryChatConfig } from "@kotoba/contracts";
import { createStructuredGenerator } from "../../../capabilities/structured-generator";
import {
  conversationSystemPrompt,
  DAILY_STORY_OPENING_MAX_TOKENS,
  openingResultSchema,
  openingUserPrompt,
} from "../policy";
import { DailyStoryProviderNotConfiguredError } from "./ports";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export function createStartConversation(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  return (input: {
    learnerId: string;
    ip?: string;
    requestId: string;
    storyZh: string;
    chat: DailyStoryChatConfig;
  }) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "chat",
      perMinute: deps.config.dailyStoryRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: async () => {
        const generated = await deps.safeProviderCall(() => {
          const chat = deps.providers({ chat: input.chat }).chat;
          if (!chat) throw new DailyStoryProviderNotConfiguredError();
          return createStructuredGenerator(chat).generate({
            schema: openingResultSchema,
            messages: [
              { role: "system", content: conversationSystemPrompt },
              { role: "user", content: openingUserPrompt(input.storyZh) },
            ],
            requestId: input.requestId,
            maxTokens: DAILY_STORY_OPENING_MAX_TOKENS,
          });
        }, input.requestId);
        return {
          opening: { id: randomUUID(), role: "assistant" as const, text: generated.value.reply },
        };
      },
    });
}
