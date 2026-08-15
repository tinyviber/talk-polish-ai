import { z } from "zod";
import {
  DAILY_STORY_LIMITS,
  dailyStoryReviewDiffSchema,
  dailyStoryReviewRubricSchema,
  providerPresetIdSchema,
} from "@kotoba/contracts";
import { dailyStorySyncConversationSchema, dailyStorySyncReviewSchema } from "@kotoba/contracts";
import type { DailyStorySyncConversation } from "@kotoba/contracts";
import type { ReviewRubric } from "../../types";
import { CURRENT } from "./database";

export const STORY_EXPORT_FORMAT = "kotoba-daily-story" as const;
export const STORY_EXPORT_VERSION = 2 as const;
export const STORY_EXPORT_LEGACY_VERSION = 1 as const;
export const MAX_STORY_TRANSFER_BYTES = 10 * 1024 * 1024;
export const MAX_STORY_TRANSFER_SESSIONS = 200;

export const providerSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(DAILY_STORY_LIMITS.providerUrlChars),
    apiKey: z.string().min(1).max(DAILY_STORY_LIMITS.providerKeyChars),
    model: z.string().trim().min(1).max(DAILY_STORY_LIMITS.modelChars),
    preset: providerPresetIdSchema.optional(),
  })
  .strict();

export const settingsSchema = z
  .object({
    id: z.literal(CURRENT),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    chat: providerSchema.optional(),
    asr: providerSchema
      .extend({ responseFormat: z.enum(["json", "verbose_json"]).optional() })
      .optional(),
    local: z
      .object({
        asrDirect: z.boolean().optional(),
      })
      .strict()
      .optional(),
    tts: providerSchema
      .extend({ voice: z.string().trim().min(1).max(DAILY_STORY_LIMITS.voiceChars) })
      .optional(),
  })
  .strict();

export const messageSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
    source: z.enum(["asr", "typed"]).optional(),
    rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
  })
  .strict();

export const sessionSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    sessionInstanceId: z.string().min(1).max(160).optional(),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(4_000),
    title: z.string().min(1).max(80).optional(),
    messages: z.array(messageSchema).max(DAILY_STORY_LIMITS.historyMessages),
    pendingAsrTranscript: z
      .object({
        id: z.string().min(1).max(128),
        text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
        rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        suggestions: z
          .array(
            z
              .object({
                sourceTurnId: z.string().min(1).max(128),
                original: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
                diff: dailyStoryReviewDiffSchema.optional(),
                improved: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
                // Existing local review snapshots predate category. Defaulting
                // keeps them recoverable; next write stores the explicit value.
                category: z.enum(["clarity", "grammar", "naturalness"]).default("naturalness"),
                explanationZh: z.string().min(1).max(600),
              })
              .strict(),
          )
          .max(3),
      })
      .strict()
      .optional(),
  })
  .strict();

export const leaseSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    ownerId: z.string().min(1).max(160),
    expiresAt: z.number().int().positive(),
    claimToken: z.string().min(1).max(160).optional(),
    // Strictly increasing within one controller. Kept optional for legacy
    // records written before claim sequencing was introduced.
    claimSequence: z.number().int().positive().optional(),
    // Legacy field retained only so old records remain readable. It is not
    // used for freshness decisions.
    claimStartedAt: z.number().int().positive().optional(),
  })
  .strict();

const safeTransferId = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const storyExportMessageSchema = z
  .object({
    id: safeTransferId(128),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
    source: z.enum(["asr", "typed"]).optional(),
    rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
  })
  .strict();

const storyExportReviewSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            sourceTurnId: safeTransferId(128),
            original: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
            diff: dailyStoryReviewDiffSchema.optional(),
            improved: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
            category: z.enum(["clarity", "grammar", "naturalness"]),
            explanationZh: z.string().min(1).max(600),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

const storyExportReviewV2Schema = storyExportReviewSchema
  .extend({
    score: z.number().int().min(0).max(100).nullable().optional(),
    comment: z.string().min(1).max(300).nullable().optional(),
    rubric: dailyStoryReviewRubricSchema.nullable().optional(),
    overallFeedback: z.string().min(1).max(600).nullable().optional(),
  })
  .strict();

export const storyExportSessionSchema = z
  .object({
    id: safeTransferId(160).refine((value) => value !== CURRENT, {
      message: "current is reserved and cannot be imported",
    }),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(4_000),
    title: z.string().min(1).max(80).optional(),
    messages: z.array(storyExportMessageSchema).max(DAILY_STORY_LIMITS.historyMessages),
    pendingAsrTranscript: z
      .object({
        id: safeTransferId(128),
        text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
        rawText: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars).optional(),
      })
      .strict()
      .optional(),
    review: storyExportReviewV2Schema.optional(),
  })
  .strict()
  .superRefine((session, ctx) => {
    const messageIds = new Set<string>();
    const userMessages = new Map<string, string>();
    for (const [index, message] of session.messages.entries()) {
      if (messageIds.has(message.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "id"],
          message: "Message ids must be unique.",
        });
      }
      messageIds.add(message.id);
      if (message.role === "user") userMessages.set(message.id, message.text);
    }
    if (session.pendingAsrTranscript && messageIds.has(session.pendingAsrTranscript.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pendingAsrTranscript", "id"],
        message: "Pending transcript id must not match a message id.",
      });
    }
    const sourceIds = new Set<string>();
    for (const [index, suggestion] of session.review?.suggestions.entries() ?? []) {
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

export const storyExportEnvelopeSchema = z
  .union([
    z
      .object({
        format: z.literal(STORY_EXPORT_FORMAT),
        version: z.literal(STORY_EXPORT_LEGACY_VERSION),
        sessions: z.array(storyExportSessionSchema).max(MAX_STORY_TRANSFER_SESSIONS),
      })
      .strict(),
    z
      .object({
        format: z.literal(STORY_EXPORT_FORMAT),
        version: z.literal(STORY_EXPORT_VERSION),
        sessions: z.array(storyExportSessionSchema).max(MAX_STORY_TRANSFER_SESSIONS),
      })
      .strict(),
  ])
  .superRefine((envelope, ctx) => {
    const ids = new Set<string>();
    for (const [index, session] of envelope.sessions.entries()) {
      if (ids.has(session.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sessions", index, "id"],
          message: "Session ids must be unique.",
        });
      }
      ids.add(session.id);
    }
  });

export const storedReviewSidecarSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(160),
    score: z.number().int().min(0).max(100).nullable(),
    comment: z.string().min(1).max(300).nullable(),
    rubric: dailyStoryReviewRubricSchema.nullable(),
    overallFeedback: z.string().min(1).max(600).nullable().optional(),
    sessionRevision: z.number().int().positive().optional(),
    sessionInstanceId: z.string().min(1).max(160).optional(),
  })
  .strict();

export type StoredSettings = z.infer<typeof settingsSchema>;
export type StoredSession = z.infer<typeof sessionSchema>;
export type StoryExportEnvelope = z.infer<typeof storyExportEnvelopeSchema>;
export type StoryExportSession = z.infer<typeof storyExportSessionSchema>;
export type StoredReviewSidecar = {
  conversationId: string;
  score: number | null;
  comment: string | null;
  rubric: ReviewRubric | null;
  overallFeedback?: string | null;
  sessionRevision?: number | undefined;
  sessionInstanceId?: string | undefined;
};

export const syncConfigSchema = z
  .object({
    id: z.literal(CURRENT),
    schemaVersion: z.literal(1),
    token: z.string().trim().min(16).max(512),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const syncMetaSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(160),
    remoteRevision: z.number().int().positive().nullable(),
    localRevision: z.number().int().nonnegative().nullable(),
    sessionInstanceId: z.string().min(1).max(160).optional(),
    reviewRepair: z
      .object({
        operation: z.enum(["upsert", "delete"]),
        remoteRevision: z.number().int().positive().nullable(),
        sessionRevision: z.number().int().nonnegative().nullable(),
        sessionInstanceId: z.string().min(1).max(160).optional(),
        review: dailyStorySyncReviewSchema.nullable(),
      })
      .strict()
      .optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const syncOutboxSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(160),
    operation: z.enum(["upsert", "delete"]),
    mutationId: z.string().min(16).max(160),
    expectedRemoteRevision: z.number().int().positive().nullable(),
    localRevision: z.number().int().nonnegative().nullable(),
    payload: dailyStorySyncConversationSchema.nullable(),
    queuedAt: z.string().datetime(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative(),
    lastError: z.string().max(600).optional(),
  })
  .strict();

export const syncConflictSchema = z
  .object({
    conflictKey: z.string().min(16).max(320),
    sourceConversationId: z.string().trim().min(1).max(160),
    operation: z.enum(["upsert", "delete"]).default("upsert"),
    conflictConversationId: z.string().trim().min(1).max(160).optional(),
    payloadHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    status: z.enum(["open", "resolved"]).default("open"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type StoredSyncConfig = z.infer<typeof syncConfigSchema>;
export type StoredSyncMeta = z.infer<typeof syncMetaSchema>;
export type StoredSyncOutbox = z.infer<typeof syncOutboxSchema> & {
  payload: DailyStorySyncConversation | null;
};
export type StoredSyncConflict = z.infer<typeof syncConflictSchema>;
