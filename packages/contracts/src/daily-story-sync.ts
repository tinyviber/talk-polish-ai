import { z } from "zod";
import {
  DAILY_STORY_LIMITS,
  dailyStoryReviewRubricSchema,
  dailyStoryReviewSuggestionSchema,
} from "./daily-story";

/** Hard bounds keep one opaque sync object cheap to validate and store. */
export const DAILY_STORY_SYNC_LIMITS = {
  objectBytes: 512 * 1024,
  /** Page size. Tombstones are retained, so a single fixed vault cap is unsafe. */
  pageSize: 100,
  conversationIdChars: 160,
  mutationIdChars: 160,
} as const;

const syncId = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const syncMessageSchema = z
  .object({
    id: syncId(128),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
    source: z.enum(["asr", "typed"]).optional(),
    rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
  })
  .strict();

const syncPendingTranscriptSchema = z
  .object({
    id: syncId(128),
    text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
    rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
  })
  .strict();

export const dailyStorySyncReviewSchema = z
  .object({
    score: z.number().int().min(0).max(100).nullable(),
    comment: z.string().min(1).max(300).nullable(),
    overallFeedback: z.string().min(1).max(600).nullable().optional(),
    rubric: dailyStoryReviewRubricSchema.nullable(),
    suggestions: z.array(dailyStoryReviewSuggestionSchema).max(3),
  })
  .strict();

export const dailyStorySyncConversationSchema = z
  .object({
    conversationId: syncId(DAILY_STORY_SYNC_LIMITS.conversationIdChars),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    sessionInstanceId: syncId(160).optional(),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(DAILY_STORY_LIMITS.storyZhChars),
    title: z.string().min(1).max(80).optional(),
    messages: z.array(syncMessageSchema).max(DAILY_STORY_LIMITS.historyMessages),
    pendingAsrTranscript: syncPendingTranscriptSchema.optional(),
    review: dailyStorySyncReviewSchema.optional(),
  })
  .strict()
  .superRefine((conversation, ctx) => {
    const messageIds = new Set<string>();
    const userMessages = new Map<string, string>();
    for (const [index, message] of conversation.messages.entries()) {
      if (messageIds.has(message.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "id"],
          message: "Conversation message ids must be unique.",
        });
      }
      messageIds.add(message.id);
      if (message.role === "user") userMessages.set(message.id, message.text);
    }
    if (conversation.pendingAsrTranscript && messageIds.has(conversation.pendingAsrTranscript.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pendingAsrTranscript", "id"],
        message: "Pending transcript id must not match a message id.",
      });
    }
    const sourceIds = new Set<string>();
    for (const [index, suggestion] of conversation.review?.suggestions.entries() ?? []) {
      if (sourceIds.has(suggestion.sourceTurnId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["review", "suggestions", index, "sourceTurnId"],
          message: "Review source ids must be unique.",
        });
      }
      sourceIds.add(suggestion.sourceTurnId);
      const original = userMessages.get(suggestion.sourceTurnId);
      if (original === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["review", "suggestions", index, "sourceTurnId"],
          message: "Review source must reference a user message.",
        });
      } else if (original !== suggestion.original) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["review", "suggestions", index, "original"],
          message: "Review original must match the source user message.",
        });
      }
    }
  });
export type DailyStorySyncConversation = z.infer<typeof dailyStorySyncConversationSchema>;

export const dailyStorySyncRemoteObjectSchema = z
  .object({
    conversationId: syncId(DAILY_STORY_SYNC_LIMITS.conversationIdChars),
    remoteRevision: z.number().int().positive(),
    clientRevision: z.number().int().nonnegative(),
    sessionInstanceId: syncId(160).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    deleted: z.boolean(),
    updatedAt: z.string().datetime(),
    payload: dailyStorySyncConversationSchema.nullable(),
  })
  .strict()
  .superRefine((object, ctx) => {
    if (object.deleted && object.payload !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "Tombstone payload must be null.",
      });
    }
    if (!object.deleted && object.payload === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "Live object needs a payload.",
      });
    }
    if (object.payload && object.payload.conversationId !== object.conversationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "conversationId"],
        message: "Conversation id mismatch.",
      });
    }
  });
export type DailyStorySyncRemoteObject = z.infer<typeof dailyStorySyncRemoteObjectSchema>;

export const dailyStorySyncPushRequestSchema = z
  .object({
    mutationId: syncId(DAILY_STORY_SYNC_LIMITS.mutationIdChars),
    expectedRemoteRevision: z.number().int().positive().nullable(),
    clientRevision: z.number().int().nonnegative(),
    sessionInstanceId: syncId(160).optional(),
    object: dailyStorySyncConversationSchema.nullable(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.object && request.object.revision !== request.clientRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientRevision"],
        message: "Client revision must match conversation revision.",
      });
    }
    if (request.object && request.sessionInstanceId !== request.object.sessionInstanceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionInstanceId"],
        message: "Session instance id must match conversation.",
      });
    }
  });
export type DailyStorySyncPushRequest = z.infer<typeof dailyStorySyncPushRequestSchema>;

export const dailyStorySyncListResponseSchema = z
  .object({
    objects: z.array(dailyStorySyncRemoteObjectSchema).max(DAILY_STORY_SYNC_LIMITS.pageSize),
    nextCursor: z.string().min(1).max(256).nullable(),
    requestId: z.string().min(1),
  })
  .strict();

export const dailyStorySyncListQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const dailyStorySyncPushResponseSchema = z
  .object({
    status: z.enum(["accepted", "already_applied"]),
    mutationId: syncId(DAILY_STORY_SYNC_LIMITS.mutationIdChars),
    object: dailyStorySyncRemoteObjectSchema,
    requestId: z.string().min(1),
  })
  .strict();

export const dailyStorySyncConflictResponseSchema = z
  .object({
    error: z.object({ code: z.literal("conflict"), message: z.string() }).strict(),
    current: dailyStorySyncRemoteObjectSchema.nullable(),
    requestId: z.string().min(1),
  })
  .strict();

export const dailyStorySyncParamsSchema = z
  .object({ conversationId: syncId(DAILY_STORY_SYNC_LIMITS.conversationIdChars) })
  .strict();
