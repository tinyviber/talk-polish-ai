import { createStructuredGenerator } from "../../../capabilities/structured-generator";
import { dailyStoryValidation } from "./errors";
import { conversationResultSchema, conversationSystemPrompt, replyUserPrompt } from "../policy";
import { DailyStoryProviderNotConfiguredError } from "./ports";
import type {
  DailyStoryConversationInput,
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export function createReplyToTurn(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  return (
    input: DailyStoryConversationInput & {
      turn: { id: string; source: "asr" | "typed"; text: string };
    },
  ) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "chat",
      perMinute: deps.config.dailyStoryRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: async () => {
        if (input.history.some((message) => message.id === input.turn.id))
          throw dailyStoryValidation("Conversation turn id must be new.");
        const generated = await deps.safeProviderCall(() => {
          const chat = deps.providers({ chat: input.chat }).chat;
          if (!chat) throw new DailyStoryProviderNotConfiguredError();
          return createStructuredGenerator(chat).generate({
            schema: conversationResultSchema,
            messages: [
              { role: "system", content: conversationSystemPrompt },
              {
                role: "user",
                content: replyUserPrompt({
                  storyZh: input.storyZh,
                  history: input.history,
                  turn: { ...input.turn, role: "user" },
                }),
              },
            ],
            requestId: input.requestId,
            maxTokens: 512,
          });
        }, input.requestId);
        return generated.value;
      },
    });
}
