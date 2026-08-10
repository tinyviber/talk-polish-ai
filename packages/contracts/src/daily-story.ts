import { z } from "zod";
import {
  dailyStoryProviderPresetIdSchema,
  identifyProviderPreset,
  normalizeProviderBaseUrl,
  type ProviderPresetId,
} from "./provider-presets";

/**
 * Isolated Daily Story wire contract. Provider credentials are intentionally
 * request-only values: no response schema contains a provider configuration.
 */
export const DAILY_STORY_LIMITS = {
  storyZhChars: 4_000,
  turnChars: 2_000,
  assistantChars: 900,
  historyMessages: 40,
  historyChars: 18_000,
  providerUrlChars: 2_048,
  providerKeyChars: 4_096,
  modelChars: 256,
  voiceChars: 128,
  audioBytes: 25 * 1024 * 1024,
  ttsChars: 2_000,
} as const;

const boundedText = (maximum: number) => z.string().min(1).max(maximum);

export const dailyProviderBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(DAILY_STORY_LIMITS.providerUrlChars)
  .transform((value, ctx) => {
    let normalized: string;
    try {
      normalized = normalizeProviderBaseUrl(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provider base URL is invalid." });
      return z.NEVER;
    }
    if (!normalized.startsWith("https://")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provider base URL must use HTTPS." });
      return z.NEVER;
    }
    if (normalized.length > DAILY_STORY_LIMITS.providerUrlChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: DAILY_STORY_LIMITS.providerUrlChars,
        inclusive: true,
        message: "Provider base URL is too long.",
      });
      return z.NEVER;
    }
    return normalized;
  });
export const dailyProviderApiKeySchema = z.string().min(1).max(DAILY_STORY_LIMITS.providerKeyChars);
export const dailyProviderModelSchema = z.string().min(1).max(DAILY_STORY_LIMITS.modelChars);

function inferAndValidatePreset(
  value: { baseUrl: string; preset?: ProviderPresetId | undefined },
  ctx: z.RefinementCtx,
) {
  const inferredPreset = identifyProviderPreset(value.baseUrl);
  if (
    value.preset !== undefined &&
    inferredPreset !== undefined &&
    value.preset !== inferredPreset
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preset"],
      message: "Provider preset does not match the endpoint.",
    });
  }
  return inferredPreset;
}

export const dailyStoryChatConfigSchema = z
  .object({
    baseUrl: dailyProviderBaseUrlSchema,
    apiKey: dailyProviderApiKeySchema,
    model: dailyProviderModelSchema,
    preset: dailyStoryProviderPresetIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    inferAndValidatePreset(value, ctx);
  });
export type DailyStoryChatConfig = z.infer<typeof dailyStoryChatConfigSchema>;

export const dailyStoryAsrConfigSchema = z
  .object({
    baseUrl: dailyProviderBaseUrlSchema,
    apiKey: dailyProviderApiKeySchema,
    model: dailyProviderModelSchema,
    preset: dailyStoryProviderPresetIdSchema.optional(),
    responseFormat: z.enum(["json", "verbose_json"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const inferredPreset = inferAndValidatePreset(value, ctx);
    if (inferredPreset === "deepseek") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preset"],
        message: "DeepSeek does not provide Daily Story ASR.",
      });
    }
  });
export type DailyStoryAsrConfig = z.infer<typeof dailyStoryAsrConfigSchema>;

export const dailyStoryTtsConfigSchema = z
  .object({
    baseUrl: dailyProviderBaseUrlSchema,
    apiKey: dailyProviderApiKeySchema,
    model: dailyProviderModelSchema,
    preset: dailyStoryProviderPresetIdSchema.optional(),
    voice: boundedText(DAILY_STORY_LIMITS.voiceChars),
  })
  .strict()
  .superRefine((value, ctx) => {
    const inferredPreset = inferAndValidatePreset(value, ctx);
    if (inferredPreset && inferredPreset !== "openai-compatible") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preset"],
        message: "This provider does not provide Daily Story TTS.",
      });
    }
  });
export type DailyStoryTtsConfig = z.infer<typeof dailyStoryTtsConfigSchema>;

export const dailyStoryCapabilitySchema = z.enum(["chat", "asr", "tts"]);
export type DailyStoryCapability = z.infer<typeof dailyStoryCapabilitySchema>;

export const dailyStoryUserTurnSourceSchema = z.enum(["asr", "typed"]);
export type DailyStoryUserTurnSource = z.infer<typeof dailyStoryUserTurnSourceSchema>;

export const dailyStoryUserTurnSchema = z
  .object({
    id: z.string().min(1).max(128),
    source: dailyStoryUserTurnSourceSchema,
    text: boundedText(DAILY_STORY_LIMITS.turnChars),
  })
  .strict();
export type DailyStoryUserTurn = z.infer<typeof dailyStoryUserTurnSchema>;

export const dailyStoryAssistantTurnSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.literal("assistant"),
    text: boundedText(DAILY_STORY_LIMITS.assistantChars),
  })
  .strict();
export type DailyStoryAssistantTurn = z.infer<typeof dailyStoryAssistantTurnSchema>;

export const dailyStoryHistoryMessageSchema = z.discriminatedUnion("role", [
  dailyStoryAssistantTurnSchema,
  dailyStoryUserTurnSchema.extend({ role: z.literal("user") }),
]);
export type DailyStoryHistoryMessage = z.infer<typeof dailyStoryHistoryMessageSchema>;

export const dailyStoryHistorySchema = z
  .array(dailyStoryHistoryMessageSchema)
  .max(DAILY_STORY_LIMITS.historyMessages)
  .superRefine((messages, ctx) => {
    const textChars = messages.reduce((sum, message) => sum + message.text.length, 0);
    if (textChars > DAILY_STORY_LIMITS.historyChars) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Conversation history is too long." });
    }
    const ids = new Set<string>();
    for (const message of messages) {
      if (ids.has(message.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Conversation message ids must be unique.",
        });
      }
      ids.add(message.id);
    }
  });

export const dailyStoryStartRequestSchema = z
  .object({
    storyZh: boundedText(DAILY_STORY_LIMITS.storyZhChars),
    chat: dailyStoryChatConfigSchema,
  })
  .strict();
export type DailyStoryStartRequest = z.infer<typeof dailyStoryStartRequestSchema>;

export const dailyStoryStartResponseSchema = z
  .object({ opening: dailyStoryAssistantTurnSchema, requestId: z.string().min(1) })
  .strict();
export type DailyStoryStartResponse = z.infer<typeof dailyStoryStartResponseSchema>;

export const dailyStoryTranscribeResponseSchema = z
  .object({
    transcript: z.string().max(DAILY_STORY_LIMITS.turnChars),
    requestId: z.string().min(1),
  })
  .strict();
export type DailyStoryTranscribeResponse = z.infer<typeof dailyStoryTranscribeResponseSchema>;

export const dailyStoryUnderstandingSchema = z.enum(["understood", "clarify", "retry"]);
export type DailyStoryUnderstanding = z.infer<typeof dailyStoryUnderstandingSchema>;

export const dailyStoryReviewCategorySchema = z.enum(["clarity", "grammar", "naturalness"]);
export type DailyStoryReviewCategory = z.infer<typeof dailyStoryReviewCategorySchema>;

export const dailyStoryReplyRequestSchema = z
  .object({
    storyZh: boundedText(DAILY_STORY_LIMITS.storyZhChars),
    history: dailyStoryHistorySchema,
    turn: dailyStoryUserTurnSchema,
    chat: dailyStoryChatConfigSchema,
  })
  .strict();
export type DailyStoryReplyRequest = z.infer<typeof dailyStoryReplyRequestSchema>;

export const dailyStoryReplyResponseSchema = z
  .object({
    understanding: dailyStoryUnderstandingSchema,
    reply: boundedText(DAILY_STORY_LIMITS.assistantChars),
    requestId: z.string().min(1),
  })
  .strict();
export type DailyStoryReplyResponse = z.infer<typeof dailyStoryReplyResponseSchema>;

export const dailyStoryReviewSuggestionSchema = z
  .object({
    sourceTurnId: z.string().min(1).max(128),
    original: boundedText(DAILY_STORY_LIMITS.turnChars),
    improved: boundedText(DAILY_STORY_LIMITS.turnChars),
    category: dailyStoryReviewCategorySchema,
    explanationZh: boundedText(600),
  })
  .strict();
export type DailyStoryReviewSuggestion = z.infer<typeof dailyStoryReviewSuggestionSchema>;

export const dailyStoryReviewRequestSchema = z
  .object({
    storyZh: boundedText(DAILY_STORY_LIMITS.storyZhChars),
    history: dailyStoryHistorySchema,
    chat: dailyStoryChatConfigSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.history.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["history"],
        message: "Conversation needs a user turn.",
      });
    }
  });
export type DailyStoryReviewRequest = z.infer<typeof dailyStoryReviewRequestSchema>;

export const dailyStoryReviewResponseSchema = z
  .object({
    suggestions: z.array(dailyStoryReviewSuggestionSchema).max(3),
    requestId: z.string().min(1),
  })
  .strict();
export type DailyStoryReviewResponse = z.infer<typeof dailyStoryReviewResponseSchema>;

export const dailyStoryTtsRequestSchema = z
  .object({ text: boundedText(DAILY_STORY_LIMITS.ttsChars), tts: dailyStoryTtsConfigSchema })
  .strict();
export type DailyStoryTtsRequest = z.infer<typeof dailyStoryTtsRequestSchema>;

export const dailyStoryProviderCheckRequestSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("chat"), provider: dailyStoryChatConfigSchema }).strict(),
  z.object({ capability: z.literal("asr"), provider: dailyStoryAsrConfigSchema }).strict(),
  z.object({ capability: z.literal("tts"), provider: dailyStoryTtsConfigSchema }).strict(),
]);
export type DailyStoryProviderCheckRequest = z.infer<typeof dailyStoryProviderCheckRequestSchema>;

export const dailyStoryProviderCheckResponseSchema = z
  .object({
    capability: dailyStoryCapabilitySchema,
    status: z.literal("connected"),
    requestId: z.string().min(1),
  })
  .strict();
export type DailyStoryProviderCheckResponse = z.infer<typeof dailyStoryProviderCheckResponseSchema>;
