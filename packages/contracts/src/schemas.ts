import { z } from "zod";
import {
  feedbackProvenanceSchema,
  pronunciationSourceSchema,
  pronunciationStatusSchema,
  speechMetricsSourceSchema,
  speechMetricsStatusSchema,
} from "./speaking-feedback";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const langSchema = z.enum(["en", "ja"]);
export type Lang = z.infer<typeof langSchema>;

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Metadata attached to every response so failures can be traced in logs. */
export const responseMetaSchema = z.object({
  requestId: z.string(),
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export const errorCodeSchema = z.enum([
  "bad_request",
  "validation_failed",
  "unauthorized",
  "conflict",
  "missing_audio",
  "unsupported_media_type",
  "payload_too_large",
  "not_found",
  "processing_unavailable",
  "storage_failure",
  "database_failure",
  "internal_error",
  "provider_unavailable",
  "rate_limited",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    /** Safe, user-presentable details only — never stack traces or credentials. */
    details: z.array(z.string()).optional(),
  }),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/* ------------------------------------------------------------------ */
/* Domain: prompts                                                     */
/* ------------------------------------------------------------------ */

export const promptSchema = z.object({
  id: z.string(),
  lang: langSchema,
  scenario: z.string(),
  situation: z.string(),
  question: z.string(),
  questionTranslation: z.string().optional(),
  hints: z.array(z.string()),
  seconds: z.number().int().positive(),
});
export type Prompt = z.infer<typeof promptSchema>;

/* ------------------------------------------------------------------ */
/* Domain: feedback                                                    */
/* ------------------------------------------------------------------ */

export const scoreKeySchema = z.enum([
  "fluency",
  "pauses",
  "grammar",
  "vocabulary",
  "naturalness",
  "pronunciation",
]);
export type ScoreKey = z.infer<typeof scoreKeySchema>;

export const scoresSchema = z.object({
  fluency: z.number().int().min(0).max(100),
  pauses: z.number().int().min(0).max(100),
  grammar: z.number().int().min(0).max(100),
  vocabulary: z.number().int().min(0).max(100),
  naturalness: z.number().int().min(0).max(100),
  /** Nullable for new results until an acoustic scorer is connected. */
  pronunciation: z.number().int().min(0).max(100).nullable(),
});
export type Scores = z.infer<typeof scoresSchema>;

export const annotationSchema = z.object({
  text: z.string(),
  kind: z.enum(["ok", "grammar", "filler", "word"]),
  note: z.string().optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const improvementSchema = z.object({
  title: z.string(),
  detail: z.string(),
  before: z.string(),
  after: z.string(),
});
export type Improvement = z.infer<typeof improvementSchema>;

export const expressionSchema = z.object({
  id: z.string().min(1).max(96),
  lang: langSchema,
  text: z.string(),
  reading: z.string().optional(),
  meaning: z.string(),
  savedAt: z.number().optional(),
});
export type Expression = z.infer<typeof expressionSchema>;

export const feedbackSchema = z.object({
  overall: z.number().int().min(0).max(100),
  headline: z.string(),
  scores: scoresSchema,
  improvements: z.array(improvementSchema),
  annotations: z.array(annotationSchema),
  expressions: z.array(expressionSchema),
  pronunciationStatus: pronunciationStatusSchema.optional(),
  pronunciationSource: pronunciationSourceSchema.optional(),
  speechMetricsStatus: speechMetricsStatusSchema.optional(),
  speechMetricsSource: speechMetricsSourceSchema.optional(),
  sources: feedbackProvenanceSchema.optional(),
  stats: z.object({
    words: z.number(),
    wpm: z.number(),
    fillers: z.number(),
    longestPause: z.string(),
  }),
});
export type Feedback = z.infer<typeof feedbackSchema>;

export const transcriptionSegmentSchema = z.object({
  id: z.number().int().nonnegative().optional(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptionSegment = z.infer<typeof transcriptionSegmentSchema>;

export const transcriptionWordTimestampSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptionWordTimestamp = z.infer<typeof transcriptionWordTimestampSchema>;

/** Provider-returned metadata only. Missing fields are intentionally omitted. */
export const transcriptionMetadataSchema = z.object({
  faithfulTranscript: z.string().optional(),
  normalizedTranscript: z.string().optional(),
  segments: z.array(transcriptionSegmentSchema).optional(),
  wordTimestamps: z.array(transcriptionWordTimestampSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptionMetadata = z.infer<typeof transcriptionMetadataSchema>;

/* ------------------------------------------------------------------ */
/* Domain: audio                                                       */
/* ------------------------------------------------------------------ */

export const SUPPORTED_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
] as const;

/** 25 MB — comfortably above a two-minute browser recording. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const audioMetadataSchema = z.object({
  id: z.string(),
  /** Opaque backend-issued playback route; provider storage keys never reach browsers. */
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  playbackUrl: z.string().optional(),
});
export type AudioMetadata = z.infer<typeof audioMetadataSchema>;

/* ------------------------------------------------------------------ */
/* Domain: learner / session / attempt                                 */
/* ------------------------------------------------------------------ */

export const learnerSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  lang: langSchema.nullable(),
  createdAt: z.string(),
});
export type Learner = z.infer<typeof learnerSchema>;

export const attemptStatusSchema = z.enum(["processing", "ready", "failed"]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const attemptSchema = z.object({
  id: z.string(),
  /** Client-generated idempotency key used by offline uploads. */
  clientAttemptId: z.string().optional(),
  sessionId: z.string(),
  index: z.union([z.literal(1), z.literal(2)]),
  status: attemptStatusSchema,
  transcript: z.string().nullable(),
  transcription: transcriptionMetadataSchema.optional(),
  feedback: feedbackSchema.nullable(),
  durationSec: z.number().nonnegative(),
  /** True when no real audio was captured (demo / mic-blocked fallback). */
  mocked: z.boolean(),
  audio: audioMetadataSchema.nullable(),
  createdAt: z.string(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const practiceSessionSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  promptId: z.string(),
  lang: langSchema,
  createdAt: z.string(),
  attempts: z.array(attemptSchema),
});
export type PracticeSession = z.infer<typeof practiceSessionSchema>;

export const savedExpressionSchema = expressionSchema.extend({
  savedAt: z.number(),
});
export type SavedExpression = z.infer<typeof savedExpressionSchema>;

/* ------------------------------------------------------------------ */
/* Domain: progress                                                    */
/* ------------------------------------------------------------------ */

export const sessionRecordSchema = z.object({
  id: z.string(),
  lang: langSchema,
  promptId: z.string(),
  date: isoDateSchema,
  first: z.number(),
  second: z.number().nullable(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const progressSchema = z.object({
  streak: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
  avgSecondAttemptGain: z.number().nullable(),
  savedCount: z.number().int().nonnegative(),
  sessions: z.array(sessionRecordSchema),
});
export type Progress = z.infer<typeof progressSchema>;

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export const createAnonymousLearnerRequestSchema = z.object({
  deviceId: z.string().min(6).max(128),
  lang: langSchema.nullish(),
});
export type CreateAnonymousLearnerRequest = z.infer<typeof createAnonymousLearnerRequestSchema>;

export const listPromptsQuerySchema = z.object({
  lang: langSchema.optional(),
});
export type ListPromptsQuery = z.infer<typeof listPromptsQuerySchema>;

export const createPracticeSessionRequestSchema = z.object({
  promptId: z.string().min(1),
  /** Client-generated idempotency key so offline devices can create a session on reconnect. */
  clientSessionId: z.string().min(8).max(128).optional(),
});
export type CreatePracticeSessionRequest = z.infer<typeof createPracticeSessionRequestSchema>;

/** Multipart text fields that accompany the uploaded audio part. */
export const createAttemptFieldsSchema = z.object({
  clientAttemptId: z.string().min(8).max(128).optional(),
  attemptIndex: z.coerce.number().int().min(1).max(2),
  durationSec: z.coerce
    .number()
    .nonnegative()
    .max(60 * 30),
  mocked: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type CreateAttemptFields = z.infer<typeof createAttemptFieldsSchema>;

export const saveExpressionRequestSchema = z.object({
  expression: expressionSchema,
});
export type SaveExpressionRequest = z.infer<typeof saveExpressionRequestSchema>;

export const idParamsSchema = z.object({ id: z.string().min(1) });
export const sessionIdParamsSchema = z.object({ sessionId: z.string().min(1) });

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export const healthResponseSchema = responseMetaSchema.extend({
  status: z.literal("ok"),
  uptimeSec: z.number(),
  version: z.string(),
  database: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const livenessResponseSchema = responseMetaSchema.extend({
  status: z.literal("ok"),
  uptimeSec: z.number(),
  version: z.string(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const readinessResponseSchema = responseMetaSchema.extend({
  status: z.literal("ready"),
  database: z.literal("up"),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export const promptsResponseSchema = responseMetaSchema.extend({
  prompts: z.array(promptSchema),
});
export type PromptsResponse = z.infer<typeof promptsResponseSchema>;

export const learnerResponseSchema = responseMetaSchema.extend({
  learner: learnerSchema,
  token: z.string().min(1),
});
export type LearnerResponse = z.infer<typeof learnerResponseSchema>;

export const practiceSessionResponseSchema = responseMetaSchema.extend({
  session: practiceSessionSchema,
});
export type PracticeSessionResponse = z.infer<typeof practiceSessionResponseSchema>;

export const attemptResponseSchema = responseMetaSchema.extend({
  attempt: attemptSchema,
});
export type AttemptResponse = z.infer<typeof attemptResponseSchema>;

export const savedExpressionsResponseSchema = responseMetaSchema.extend({
  expressions: z.array(savedExpressionSchema),
});
export type SavedExpressionsResponse = z.infer<typeof savedExpressionsResponseSchema>;

export const savedExpressionResponseSchema = responseMetaSchema.extend({
  expression: savedExpressionSchema,
});
export type SavedExpressionResponse = z.infer<typeof savedExpressionResponseSchema>;

export const progressResponseSchema = responseMetaSchema.extend({
  progress: progressSchema,
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

export const deleteSavedExpressionResponseSchema = responseMetaSchema.extend({
  deleted: z.literal(true),
});
export type DeleteSavedExpressionResponse = z.infer<typeof deleteSavedExpressionResponseSchema>;

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export const providerStatusSchema = z.enum(["configured", "available", "unsupported", "failed"]);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const providerCapabilitySchema = z.object({
  status: providerStatusSchema,
  provider: z.string(),
  checkedAt: z.string().optional(),
  errorCode: z.string().optional(),
});
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerDiagnosticsSchema = responseMetaSchema.extend({
  storage: providerCapabilitySchema,
  database: providerCapabilitySchema,
  chat: providerCapabilitySchema,
  transcription: providerCapabilitySchema,
  tts: providerCapabilitySchema,
  realtime: providerCapabilitySchema,
});
export type ProviderDiagnostics = z.infer<typeof providerDiagnosticsSchema>;

export const synthesisRequestSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  lang: langSchema,
  voice: z.string().trim().min(1).max(64).optional(),
  purpose: z.enum(["prompt", "answer", "expression"]).optional(),
});
export type SynthesisRequest = z.infer<typeof synthesisRequestSchema>;

export const synthesisResponseSchema = responseMetaSchema.extend({
  audio: z.object({
    playbackUrl: z.string().nullable(),
    seconds: z.number().positive(),
    provider: z.string(),
  }),
});
export type SynthesisResponse = z.infer<typeof synthesisResponseSchema>;

export const realtimeSmokeResponseSchema = responseMetaSchema.extend({
  capability: z.literal("realtime"),
  status: providerStatusSchema,
  provider: z.string(),
  protocol: z.literal("websocket"),
  errorCode: z.string().optional(),
});
export type RealtimeSmokeResponse = z.infer<typeof realtimeSmokeResponseSchema>;
