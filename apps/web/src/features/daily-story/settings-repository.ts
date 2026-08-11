import { z } from "zod";
import {
  DAILY_STORY_LIMITS,
  dailyStoryAsrConfigSchema,
  dailyStoryChatConfigSchema,
  dailyStoryReviewRubricSchema,
  dailyStoryTtsConfigSchema,
  identifyProviderPreset,
  normalizeProviderBaseUrl,
  providerPresetIdSchema,
  type ProviderPresetId,
} from "@kotoba/contracts";
import type {
  AsrProvider,
  ChatProvider,
  DailyCapability,
  DailyReview,
  ProviderSettings,
  ReviewRubric,
  StorySession,
  StorySessionSnapshot,
  StorySessionSummary,
  TtsProvider,
} from "./types";
import { createConversationId } from "./types";

const DB_NAME = "kotoba-loop-settings";
const DB_VERSION = 2;
const SETTINGS_STORE = "providerSettings";
const SESSION_STORE = "storySessions";
const LEASE_STORE = "storyLeases";
const CURRENT = "current";
const LEASE_MS = 15_000;
const STORY_EXPORT_FORMAT = "kotoba-daily-story" as const;
const STORY_EXPORT_VERSION = 2 as const;
const STORY_EXPORT_LEGACY_VERSION = 1 as const;
const MAX_STORY_TRANSFER_BYTES = 10 * 1024 * 1024;
const MAX_STORY_TRANSFER_SESSIONS = 200;
const REVIEW_DB_NAME = "kotoba-daily-story-review-v2";
const REVIEW_DB_VERSION = 1;
const REVIEW_STORE = "reviews";

const providerSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(DAILY_STORY_LIMITS.providerUrlChars),
    apiKey: z.string().min(1).max(DAILY_STORY_LIMITS.providerKeyChars),
    model: z.string().trim().min(1).max(DAILY_STORY_LIMITS.modelChars),
    preset: providerPresetIdSchema.optional(),
  })
  .strict();
const settingsSchema = z
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
const messageSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
    source: z.enum(["asr", "typed"]).optional(),
  })
  .strict();
const sessionSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(4_000),
    messages: z.array(messageSchema).max(DAILY_STORY_LIMITS.historyMessages),
    pendingAsrTranscript: z
      .object({
        id: z.string().min(1).max(128),
        text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
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
const leaseSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    ownerId: z.string().min(1).max(160),
    expiresAt: z.number().int().positive(),
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
  })
  .strict();

const storyExportSessionSchema = z
  .object({
    id: safeTransferId(160).refine((value) => value !== CURRENT, {
      message: "current is reserved and cannot be imported",
    }),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(4_000),
    messages: z.array(storyExportMessageSchema).max(DAILY_STORY_LIMITS.historyMessages),
    pendingAsrTranscript: z
      .object({
        id: safeTransferId(128),
        text: z.string().min(1).max(DAILY_STORY_LIMITS.turnChars),
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

const storyExportEnvelopeSchema = z
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

const storedReviewSidecarSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(160),
    score: z.number().int().min(0).max(100).nullable(),
    comment: z.string().min(1).max(300).nullable(),
    rubric: dailyStoryReviewRubricSchema.nullable(),
  })
  .strict();

type StoredSettings = z.infer<typeof settingsSchema>;
type StoredSession = z.infer<typeof sessionSchema>;
type StoryExportEnvelope = z.infer<typeof storyExportEnvelopeSchema>;
type StoryExportSession = z.infer<typeof storyExportSessionSchema>;
type StoredReviewSidecar = {
  conversationId: string;
  score: number | null;
  comment: string | null;
  rubric: ReviewRubric | null;
};
type DailyStorageEvent =
  | { kind: "settings"; revision: number }
  | { kind: "session"; conversationId: string; revision: number }
  | { kind: "lease"; conversationId: string; ownerId: string };

export class DailyStorageError extends Error {
  constructor(message = "当前浏览器无法访问本机存储。请允许此网站使用 IndexedDB 后重试。") {
    super(message);
    this.name = "DailyStorageError";
  }
}

export class SessionConflictError extends Error {
  constructor() {
    super("此对话已在另一标签页更新。已载入最新内容。");
    this.name = "SessionConflictError";
  }
}

export class StoryImportError extends Error {
  constructor(message = "导入文件无效，未修改现有对话。") {
    super(message);
    this.name = "StoryImportError";
  }
}

let openPromise: Promise<IDBDatabase> | undefined;
let cachedDatabase: IDBDatabase | undefined;
let reviewOpenPromise: Promise<IDBDatabase> | undefined;
let cachedReviewDatabase: IDBDatabase | undefined;
let channel: BroadcastChannel | undefined;
const listeners = new Set<(event: DailyStorageEvent) => void>();

type DailyDatabase = IDBDatabase & {
  /** Chromium exposes this event when the connection is closed abnormally. */
  onclose?: ((event: Event) => void) | null;
};

const RECOVERABLE_DATABASE_ERROR_NAMES = new Set([
  "AbortError",
  "InvalidStateError",
  "TransactionInactiveError",
  "TransactionClosedError",
  "DatabaseClosedError",
]);

function errorName(error: unknown) {
  return error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
}

function isRecoverableDatabaseError(error: unknown) {
  return (
    typeof errorName(error) === "string" &&
    RECOVERABLE_DATABASE_ERROR_NAMES.has(errorName(error) as string)
  );
}

function normalizeStorageError(error: unknown) {
  if (
    error instanceof DailyStorageError ||
    error instanceof SessionConflictError ||
    error instanceof StoryImportError
  )
    return error;
  return new DailyStorageError();
}

function resetCachedConnection() {
  const db = cachedDatabase;
  cachedDatabase = undefined;
  openPromise = undefined;
  try {
    db?.close();
  } catch {
    // The connection is already unusable; the next operation will reopen it.
  }
}

function resetCachedReviewConnection() {
  const db = cachedReviewDatabase;
  cachedReviewDatabase = undefined;
  reviewOpenPromise = undefined;
  try {
    db?.close();
  } catch {
    // The connection is already unusable; the next operation will reopen it.
  }
}

function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new DailyStorageError());
  if (!openPromise) {
    const pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        reject(new DailyStorageError());
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SETTINGS_STORE))
          db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SESSION_STORE))
          db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(LEASE_STORE))
          db.createObjectStore(LEASE_STORE, { keyPath: "id" });
      };
      request.onblocked = () => {
        resetCachedConnection();
        reject(
          new DailyStorageError(
            "浏览器正在阻止设置数据库升级。请关闭其它打开此应用的标签页后重试。",
          ),
        );
      };
      request.onerror = () => {
        reject(new DailyStorageError());
      };
      request.onsuccess = () => {
        const db = request.result;
        cachedDatabase = db;
        const dailyDb = db as DailyDatabase;
        const clearIfCached = () => {
          if (cachedDatabase !== db) return;
          cachedDatabase = undefined;
          openPromise = undefined;
        };
        dailyDb.onclose = clearIfCached;
        dailyDb.onversionchange = () => {
          db.close();
          clearIfCached();
        };
        resolve(db);
      };
    });
    const trackedPromise = pendingPromise.catch((error: unknown) => {
      if (openPromise === trackedPromise) openPromise = undefined;
      throw normalizeStorageError(error);
    });
    openPromise = trackedPromise;
  }
  return openPromise;
}

function reviewDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new DailyStorageError());
  if (!reviewOpenPromise) {
    const pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(REVIEW_DB_NAME, REVIEW_DB_VERSION);
      } catch {
        reject(new DailyStorageError());
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REVIEW_STORE))
          db.createObjectStore(REVIEW_STORE, { keyPath: "conversationId" });
      };
      request.onerror = () => reject(new DailyStorageError());
      request.onsuccess = () => {
        const db = request.result;
        cachedReviewDatabase = db;
        const clearIfCached = () => {
          if (cachedReviewDatabase !== db) return;
          cachedReviewDatabase = undefined;
          reviewOpenPromise = undefined;
        };
        db.onclose = clearIfCached;
        db.onversionchange = () => {
          db.close();
          clearIfCached();
        };
        resolve(db);
      };
    });
    const trackedPromise = pendingPromise.catch((error: unknown) => {
      if (reviewOpenPromise === trackedPromise) reviewOpenPromise = undefined;
      throw normalizeStorageError(error);
    });
    reviewOpenPromise = trackedPromise;
  }
  return reviewOpenPromise;
}

function runTransaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, abort: (error: unknown) => void) => void,
) {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let tx: IDBTransaction;
        let failure: unknown;
        let aborted = false;
        const abort = (error: unknown) => {
          failure = error;
          if (aborted) return;
          aborted = true;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          tx = db.transaction(stores, mode);
          tx.oncomplete = () => resolve(result!);
          tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new DailyStorageError());
          (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult = (
            value,
          ) => {
            result = value;
          };
          run(tx, abort);
        } catch (error) {
          abort(error);
        }
      }),
  );
}

function transaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, abort: (error: unknown) => void) => void,
) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runTransaction<T>(stores, mode, run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}

function runReviewTransaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, abort: (error: unknown) => void) => void,
) {
  return reviewDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let tx: IDBTransaction;
        let failure: unknown;
        let aborted = false;
        const abort = (error: unknown) => {
          failure = error;
          if (aborted) return;
          aborted = true;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          tx = db.transaction(REVIEW_STORE, mode);
          tx.oncomplete = () => resolve(result!);
          tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new DailyStorageError());
          (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult = (
            value,
          ) => {
            result = value;
          };
          run(tx, abort);
        } catch (error) {
          abort(error);
        }
      }),
  );
}

function reviewTransaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, abort: (error: unknown) => void) => void,
) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runReviewTransaction<T>(mode, run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedReviewConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}

function setResult<T>(tx: IDBTransaction, value: T) {
  (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult?.(value);
}

function runSessionImportTransaction<T>(
  run: (
    tx: IDBTransaction,
    setTransactionResult: (value: T) => void,
    abort: (error: unknown) => void,
  ) => void,
) {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let failure: unknown;
        let tx: IDBTransaction | undefined;
        const abort = (error: unknown) => {
          failure = error;
          if (!tx) {
            reject(error);
            return;
          }
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          const opened = db.transaction([SESSION_STORE, LEASE_STORE], "readwrite");
          tx = opened;
          opened.oncomplete = () => resolve(result!);
          opened.onerror = opened.onabort = () =>
            reject(failure ?? opened.error ?? new DailyStorageError());
          run(
            opened,
            (value) => {
              result = value;
            },
            abort,
          );
        } catch (error) {
          failure = error;
          if (!tx) {
            reject(error);
            return;
          }
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        }
      }),
  );
}

function sessionImportTransaction<T>(
  run: (
    tx: IDBTransaction,
    setTransactionResult: (value: T) => void,
    abort: (error: unknown) => void,
  ) => void,
) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runSessionImportTransaction(run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}

function notifySettings(revision: number) {
  if (typeof BroadcastChannel === "undefined") return;
  channel ??= new BroadcastChannel("kotoba-daily-story-v1");
  channel.postMessage({ kind: "settings", revision });
}

function notifySession(conversationId: string, revision: number) {
  if (typeof BroadcastChannel === "undefined") return;
  channel ??= new BroadcastChannel("kotoba-daily-story-v1");
  channel.postMessage({ kind: "session", conversationId, revision });
}

function notifyLease(conversationId: string, ownerId: string) {
  if (typeof BroadcastChannel === "undefined") return;
  channel ??= new BroadcastChannel("kotoba-daily-story-v1");
  channel.postMessage({ kind: "lease", conversationId, ownerId });
}

function fromStoredSettings(value: StoredSettings): ProviderSettings {
  const normalize = <
    T extends {
      baseUrl: string;
      apiKey: string;
      model: string;
      preset?: ProviderPresetId | undefined;
    },
  >(
    provider: T,
  ): Omit<T, "preset"> & { preset?: ProviderPresetId } => {
    let baseUrl = provider.baseUrl.trim();
    try {
      baseUrl = normalizeProviderBaseUrl(baseUrl);
    } catch {
      // Preserve malformed legacy data so the user can repair it in Settings.
    }
    const preset = identifyProviderPreset(baseUrl);
    const { preset: _storedPreset, ...providerWithoutPreset } = provider;
    return {
      ...providerWithoutPreset,
      baseUrl,
      ...(preset ? { preset } : {}),
    };
  };
  const asr = value.asr
    ? normalize({
        baseUrl: value.asr.baseUrl,
        apiKey: value.asr.apiKey,
        model: value.asr.model,
        ...(value.asr.preset ? { preset: value.asr.preset } : {}),
        ...(value.asr.responseFormat ? { responseFormat: value.asr.responseFormat } : {}),
      })
    : undefined;
  const chat = value.chat ? normalize(value.chat) : undefined;
  const tts = value.tts ? normalize(value.tts) : undefined;
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(chat ? { chat } : {}),
    ...(asr ? { asr } : {}),
    ...(value.local?.asrDirect ? { local: { asrDirect: true } } : {}),
    ...(tts ? { tts } : {}),
  };
}

function fromStoredSession(value: StoredSession): StorySession {
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
    phase: value.phase,
    storyZh: value.storyZh,
    messages: value.messages.map((item) => ({
      id: item.id,
      role: item.role,
      text: item.text,
      ...(item.source ? { source: item.source } : {}),
    })),
    ...(value.pendingAsrTranscript ? { pendingAsrTranscript: value.pendingAsrTranscript } : {}),
    ...(value.review
      ? {
          review: {
            score: null,
            comment: null,
            rubric: null,
            suggestions: value.review.suggestions,
          },
        }
      : {}),
  };
}

export type DailyReviewSidecar = Pick<DailyReview, "score" | "comment" | "rubric">;

function sidecarRecord(conversationId: string, review: DailyReviewSidecar): StoredReviewSidecar {
  return storedReviewSidecarSchema.parse({ conversationId, ...review });
}

export async function readDailyStoryReview(
  conversationId: string,
): Promise<DailyReviewSidecar | null> {
  const result = await reviewTransaction<DailyReviewSidecar | null>("readonly", (tx) => {
    const request = tx.objectStore(REVIEW_STORE).get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      if (record === undefined) {
        setResult(tx, null);
        return;
      }
      const parsed = storedReviewSidecarSchema.parse(record);
      setResult(tx, {
        score: parsed.score,
        comment: parsed.comment,
        rubric: parsed.rubric,
      });
    };
  });
  return result;
}

export async function writeDailyStoryReview(
  conversationId: string,
  review: DailyReviewSidecar,
): Promise<DailyReviewSidecar> {
  const normalized = {
    score: review.score ?? null,
    comment: review.comment ?? null,
    rubric: review.rubric ?? null,
  } satisfies DailyReviewSidecar;
  if (normalized.score === null && normalized.comment === null && normalized.rubric === null) {
    await deleteDailyStoryReview(conversationId);
    return normalized;
  }
  await reviewTransaction<void>("readwrite", (tx, abort) => {
    try {
      const request = tx.objectStore(REVIEW_STORE).put(sidecarRecord(conversationId, normalized));
      request.onsuccess = () => setResult(tx, undefined);
    } catch (error) {
      abort(error);
    }
  });
  return normalized;
}

export async function deleteDailyStoryReview(conversationId: string): Promise<void> {
  await reviewTransaction<void>("readwrite", (tx) => {
    const request = tx.objectStore(REVIEW_STORE).delete(conversationId);
    request.onsuccess = () => setResult(tx, undefined);
  });
}

function mergeReview(session: StorySession, sidecar: DailyReviewSidecar | null): StorySession {
  if (!session.review) return session;
  return {
    ...session,
    review: {
      score: sidecar?.score ?? null,
      comment: sidecar?.comment ?? null,
      rubric: sidecar?.rubric ?? null,
      suggestions: session.review.suggestions,
    },
  };
}

function settingsRecord(settings: ProviderSettings): StoredSettings {
  return settingsSchema.parse({ id: CURRENT, ...settings });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function sessionRecord(session: StorySession, conversationId: string): StoredSession {
  const { review, ...withoutReview } = session;
  return sessionSchema.parse({
    id: conversationId,
    ...withoutReview,
    ...(review ? { review: { suggestions: review.suggestions } } : {}),
  });
}

function exportSessionRecord(
  value: unknown,
  reviewSidecar: DailyReviewSidecar | null,
): StoryExportSession {
  const parsed = sessionSchema.parse(value);
  const projected = {
    id: parsed.id,
    updatedAt: parsed.updatedAt,
    phase: parsed.phase,
    storyZh: parsed.storyZh,
    messages: parsed.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.source ? { source: message.source } : {}),
    })),
    ...(parsed.pendingAsrTranscript ? { pendingAsrTranscript: parsed.pendingAsrTranscript } : {}),
    ...(parsed.review
      ? {
          review: {
            ...parsed.review,
            score: reviewSidecar?.score ?? null,
            comment: reviewSidecar?.comment ?? null,
            rubric: reviewSidecar?.rubric ?? null,
          },
        }
      : {}),
  };
  return storyExportSessionSchema.parse(projected);
}

function importedSessionRecord(session: StoryExportSession): StoredSession {
  return sessionSchema.parse({
    id: session.id,
    schemaVersion: 1,
    revision: 1,
    updatedAt: session.updatedAt,
    phase: session.phase,
    storyZh: session.storyZh,
    messages: session.messages,
    ...(session.pendingAsrTranscript ? { pendingAsrTranscript: session.pendingAsrTranscript } : {}),
    ...(session.review ? { review: { suggestions: session.review.suggestions } } : {}),
  });
}

function importedReviewSidecar(session: StoryExportSession): DailyReviewSidecar | null {
  if (!session.review) return null;
  return {
    score: session.review.score ?? null,
    comment: session.review.comment ?? null,
    rubric: session.review.rubric ?? null,
  };
}

function transferBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeProviderForStorage<T extends ChatProvider>(provider: T): T {
  try {
    const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
    if (!baseUrl.startsWith("https://")) throw new TypeError("HTTPS required");
    const preset = identifyProviderPreset(baseUrl);
    const { preset: _providedPreset, ...providerWithoutPreset } = provider;
    return {
      ...providerWithoutPreset,
      baseUrl,
      ...(preset ? { preset } : {}),
    } as T;
  } catch {
    throw new DailyStorageError("Endpoint 必须是有效的 HTTPS Base URL。请检查地址后重试。");
  }
}

function validateProviderForStorage(
  capability: DailyCapability,
  provider: ChatProvider | AsrProvider | TtsProvider,
) {
  try {
    if (capability === "chat") return dailyStoryChatConfigSchema.parse(provider);
    if (capability === "asr") return dailyStoryAsrConfigSchema.parse(provider);
    return dailyStoryTtsConfigSchema.parse(provider);
  } catch {
    const label = capability === "chat" ? "Chat" : capability.toUpperCase();
    throw new DailyStorageError(
      `${label} 配置与当前 provider 能力或 Daily Story 参数限制不匹配，请检查 endpoint、model、API Key${capability === "asr" ? " 和 responseFormat" : capability === "tts" ? " 和 voice" : ""} 后重试。`,
    );
  }
}

export async function ensureDailyStorage() {
  await database();
  await migrateLegacySession();
}

export async function exportStorySessions(): Promise<string> {
  await ensureDailyStorage();
  const records = await transaction<unknown[]>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => {
      setResult(tx, request.result as unknown[]);
    };
  });

  if (records.length > MAX_STORY_TRANSFER_SESSIONS) {
    throw new StoryImportError("对话数量超过导出上限。");
  }

  const sidecars = await Promise.all(
    records.map(async (record) => {
      const id = record && typeof record === "object" ? (record as { id?: unknown }).id : null;
      return typeof id === "string" ? readDailyStoryReview(id) : null;
    }),
  );
  let envelope: StoryExportEnvelope;
  try {
    envelope = storyExportEnvelopeSchema.parse({
      format: STORY_EXPORT_FORMAT,
      version: STORY_EXPORT_VERSION,
      sessions: records.map((record, index) =>
        exportSessionRecord(record, sidecars[index] ?? null),
      ),
    });
  } catch {
    throw new StoryImportError(
      "本机存在无法导出的旧对话，未生成文件。请先打开并保存相关对话后重试。",
    );
  }
  const json = JSON.stringify(envelope);
  if (transferBytes(json) > MAX_STORY_TRANSFER_BYTES) {
    throw new StoryImportError("对话数据超过 10 MiB 导出上限。");
  }
  return json;
}

export async function importStorySessions(jsonText: string): Promise<{
  imported: number;
  migratedLegacy: boolean;
}> {
  if (typeof jsonText !== "string" || transferBytes(jsonText) > MAX_STORY_TRANSFER_BYTES) {
    throw new StoryImportError("导入文件超过 10 MiB 上限，未修改现有对话。");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new StoryImportError("导入文件不是有效 JSON，未修改现有对话。");
  }
  const parsed = storyExportEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StoryImportError("导入文件格式或内容无效，未修改现有对话。");
  }
  if (parsed.data.sessions.length === 0) return { imported: 0, migratedLegacy: false };

  const imported = parsed.data.sessions.map(importedSessionRecord);
  const importedSidecars = parsed.data.sessions.map(importedReviewSidecar);
  const result = await sessionImportTransaction<{
    importedIds: string[];
    migratedId?: string;
    migratedRevision?: number;
  }>((tx, setTransactionResult, abort) => {
    const sessionStore = tx.objectStore(SESSION_STORE);
    const leaseStore = tx.objectStore(LEASE_STORE);
    const sessionsRequest = sessionStore.getAll();
    const leaseRequest = leaseStore.get(CURRENT);
    let sessionsLoaded = false;
    let leaseLoaded = false;

    const validateAndWrite = () => {
      if (!sessionsLoaded || !leaseLoaded) return;
      try {
        const records = sessionsRequest.result as unknown[];
        const existingIds = new Set<string>();
        let legacyRaw: unknown;
        for (const record of records) {
          if (!record || typeof record !== "object") continue;
          const id = (record as { id?: unknown }).id;
          if (typeof id !== "string") continue;
          existingIds.add(id);
          if (id === CURRENT) legacyRaw = record;
        }

        let migratedRecord: StoredSession | undefined;
        let migratedId: string | undefined;
        if (legacyRaw !== undefined) {
          const legacy = sessionSchema.parse(legacyRaw);
          do {
            migratedId = createConversationId();
          } while (existingIds.has(migratedId));
          existingIds.add(migratedId);
          migratedRecord = { ...legacy, id: migratedId };
          if (leaseRequest.result !== undefined) leaseSchema.parse(leaseRequest.result);
        }

        for (const record of imported) {
          if (existingIds.has(record.id)) {
            throw new StoryImportError(`对话 ID 已存在：${record.id}`);
          }
          existingIds.add(record.id);
        }

        if (migratedRecord && migratedId) {
          sessionStore.add(migratedRecord);
          sessionStore.delete(CURRENT);
          const legacyLease =
            leaseRequest.result === undefined ? undefined : leaseSchema.parse(leaseRequest.result);
          if (legacyLease) {
            leaseStore.add({ ...legacyLease, id: migratedId });
            leaseStore.delete(CURRENT);
          }
        }
        for (const record of imported) sessionStore.add(record);
        setTransactionResult({
          importedIds: imported.map((record) => record.id),
          ...(migratedRecord && migratedId
            ? { migratedId, migratedRevision: migratedRecord.revision }
            : {}),
        });
      } catch (error) {
        abort(error);
      }
    };

    sessionsRequest.onsuccess = () => {
      sessionsLoaded = true;
      validateAndWrite();
    };
    leaseRequest.onsuccess = () => {
      leaseLoaded = true;
      validateAndWrite();
    };
  });

  if (result.migratedId && result.migratedRevision !== undefined) {
    notifySession(result.migratedId, result.migratedRevision);
  }
  for (const [index, id] of result.importedIds.entries()) {
    const sidecar = importedSidecars[index];
    if (
      sidecar &&
      (sidecar.score !== null || sidecar.comment !== null || sidecar.rubric !== null)
    ) {
      await writeDailyStoryReview(id, sidecar);
    } else {
      await deleteDailyStoryReview(id);
    }
    notifySession(id, 1);
  }
  return { imported: result.importedIds.length, migratedLegacy: !!result.migratedId };
}

export async function readProviderSettings(): Promise<ProviderSettings> {
  const result = await transaction<ProviderSettings>(SETTINGS_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const defaultSettings: ProviderSettings = {
        schemaVersion: 1,
        revision: 0,
        updatedAt: new Date(0).toISOString(),
      };
      if (record === undefined) {
        setResult(tx, defaultSettings);
        return;
      }
      const parsed = settingsSchema.parse(record);
      const normalized = fromStoredSettings(parsed);
      const canonical = settingsRecord(normalized);
      if (sameValue(parsed, canonical)) {
        setResult(tx, normalized);
        return;
      }
      const write = store.put(canonical);
      write.onsuccess = () => setResult(tx, normalized);
    };
  });
  return result;
}

export async function writeProviderSettings(
  updater: (
    current: ProviderSettings,
  ) => Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
): Promise<ProviderSettings> {
  const result = await transaction<ProviderSettings>(SETTINGS_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SETTINGS_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const current =
        record === undefined
          ? { schemaVersion: 1 as const, revision: 0, updatedAt: new Date(0).toISOString() }
          : fromStoredSettings(settingsSchema.parse(record));
      const next: ProviderSettings = {
        ...updater(current),
        schemaVersion: 1,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const write = store.put(settingsRecord(next));
      write.onsuccess = () => setResult(tx, next);
    };
  });
  notifySettings(result.revision);
  return result;
}

export function saveProvider(
  capability: DailyCapability,
  provider: ProviderSettings[DailyCapability],
) {
  if (!provider) throw new DailyStorageError("配置不完整，无法保存。");
  const normalized = normalizeProviderForStorage(provider);
  const validated = validateProviderForStorage(capability, normalized);
  return writeProviderSettings(
    (current) =>
      ({
        ...(current.chat ? { chat: current.chat } : {}),
        ...(current.asr ? { asr: current.asr } : {}),
        ...(current.local ? { local: current.local } : {}),
        ...(current.tts ? { tts: current.tts } : {}),
        [capability]: validated,
      }) as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
  );
}

export function saveAsrDirectPreference(enabled: boolean) {
  return writeProviderSettings((current) => ({
    ...(current.chat ? { chat: current.chat } : {}),
    ...(current.asr ? { asr: current.asr } : {}),
    ...(enabled ? { local: { asrDirect: true } } : {}),
    ...(current.tts ? { tts: current.tts } : {}),
  }));
}

/** Test-only seam: close the cached connection so open failure recovery is measurable. */
export async function __resetDailyStorageForTests() {
  resetCachedConnection();
}

/** Test-only seam: leave the stale connection cached so the next operation must recover it. */
export async function __closeDailyStorageConnectionForTests() {
  const db = await database();
  db.close();
}

export function clearProvider(capability: DailyCapability) {
  return writeProviderSettings((current) => {
    const next: { chat?: ChatProvider; asr?: AsrProvider; tts?: TtsProvider } = {
      ...(current.chat ? { chat: current.chat } : {}),
      ...(current.asr ? { asr: current.asr } : {}),
      ...(current.tts ? { tts: current.tts } : {}),
    };
    delete next[capability];
    return {
      ...next,
      ...(current.local ? { local: current.local } : {}),
    } as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">;
  });
}

export function clearAllProviders() {
  return writeProviderSettings(() => ({}));
}

async function migrateLegacySession() {
  return transaction<string | null>([SESSION_STORE, LEASE_STORE], "readwrite", (tx) => {
    const sessions = tx.objectStore(SESSION_STORE);
    const leases = tx.objectStore(LEASE_STORE);
    const sessionRequest = sessions.get(CURRENT);
    const leaseRequest = leases.get(CURRENT);
    let sessionLoaded = false;
    let leaseLoaded = false;

    const finish = () => {
      if (!sessionLoaded || !leaseLoaded) return;
      const legacy = sessionRequest.result as StoredSession | undefined;
      if (!legacy) {
        setResult(tx, null);
        return;
      }
      const conversationId = createConversationId();
      sessions.put({ ...legacy, id: conversationId });
      sessions.delete(CURRENT);
      const legacyLease = leaseRequest.result as
        { id: string; ownerId: string; expiresAt: number } | undefined;
      if (legacyLease) {
        leases.put({ ...legacyLease, id: conversationId });
        leases.delete(CURRENT);
      }
      setResult(tx, conversationId);
    };
    sessionRequest.onsuccess = () => {
      sessionLoaded = true;
      finish();
    };
    leaseRequest.onsuccess = () => {
      leaseLoaded = true;
      finish();
    };
  });
}

export async function listStorySessions(): Promise<StorySessionSummary[]> {
  await ensureDailyStorage();
  const records = await transaction<unknown[]>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => {
      setResult(tx, request.result as unknown[]);
    };
  });
  const sessions = await Promise.all(
    records.map(async (record) => {
      const parsed = sessionSchema.parse(record);
      const session = fromStoredSession(parsed);
      const review = await readDailyStoryReview(parsed.id);
      return {
        id: parsed.id,
        revision: parsed.revision,
        updatedAt: parsed.updatedAt,
        phase: parsed.phase,
        storyZh: parsed.storyZh,
        review: session.review ? (mergeReview(session, review).review ?? null) : null,
      } satisfies StorySessionSummary;
    }),
  );
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readStorySession(conversationId = CURRENT): Promise<StorySession | null> {
  const session = await transaction<StorySession | null>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      setResult(tx, record === undefined ? null : fromStoredSession(sessionSchema.parse(record)));
    };
  });
  return session ? mergeReview(session, await readDailyStoryReview(conversationId)) : null;
}

/** CAS writes stop stale tabs from undoing newer turns. */
export function writeStorySession(
  session: StorySessionSnapshot,
  expectedRevision: number | null,
): Promise<StorySession>;
export function writeStorySession(
  conversationId: string,
  session: StorySessionSnapshot,
  expectedRevision: number | null,
  ownerId?: string,
): Promise<StorySession>;
export async function writeStorySession(
  conversationIdOrSession: string | StorySessionSnapshot,
  sessionOrExpectedRevision: StorySessionSnapshot | number | null,
  explicitExpectedRevision?: number | null,
  explicitOwnerId?: string,
): Promise<StorySession> {
  const conversationId =
    typeof conversationIdOrSession === "string" ? conversationIdOrSession : CURRENT;
  const session =
    typeof conversationIdOrSession === "string"
      ? (sessionOrExpectedRevision as StorySessionSnapshot)
      : conversationIdOrSession;
  const expectedRevision =
    typeof conversationIdOrSession === "string"
      ? explicitExpectedRevision!
      : (sessionOrExpectedRevision as number | null);
  const ownerId = typeof conversationIdOrSession === "string" ? explicitOwnerId : undefined;
  const result = await transaction<StorySession>(
    ownerId ? [SESSION_STORE, LEASE_STORE] : SESSION_STORE,
    "readwrite",
    (tx, abort) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const leaseRequest = ownerId ? tx.objectStore(LEASE_STORE).get(conversationId) : undefined;
      let storedSessionRecord: StoredSession | undefined;
      let leaseRecord: unknown;
      let sessionReady = false;
      let leaseReady = !ownerId;
      const commit = () => {
        if (!sessionReady || !leaseReady) return;
        try {
          if (ownerId) {
            const lease = leaseRecord === undefined ? null : leaseSchema.parse(leaseRecord);
            if (lease?.ownerId !== ownerId) {
              abort(new SessionConflictError());
              return;
            }
          }
          const previous =
            storedSessionRecord === undefined
              ? null
              : fromStoredSession(sessionSchema.parse(storedSessionRecord));
          if ((previous?.revision ?? null) !== expectedRevision) {
            abort(new SessionConflictError());
            return;
          }
          const { review: snapshotReview, ...sessionWithoutReview } = session;
          const next: StorySession = {
            ...sessionWithoutReview,
            ...(snapshotReview
              ? {
                  review:
                    "score" in snapshotReview
                      ? snapshotReview
                      : {
                          score: null,
                          comment: null,
                          rubric: null,
                          suggestions: snapshotReview.suggestions,
                        },
                }
              : {}),
            schemaVersion: 1,
            revision: (previous?.revision ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          };
          const write = store.put(sessionRecord(next, conversationId));
          write.onsuccess = () => setResult(tx, next);
        } catch (error) {
          abort(error);
        }
      };
      request.onsuccess = () => {
        try {
          storedSessionRecord = request.result as StoredSession | undefined;
          sessionReady = true;
          commit();
        } catch (error) {
          abort(error);
        }
      };
      if (leaseRequest) {
        leaseRequest.onsuccess = () => {
          try {
            leaseRecord = leaseRequest.result;
            leaseReady = true;
            commit();
          } catch (error) {
            abort(error);
          }
        };
      }
    },
  );
  if (result.review) {
    await writeDailyStoryReview(conversationId, result.review);
  } else {
    await deleteDailyStoryReview(conversationId);
  }
  notifySession(conversationId, result.revision);
  return result;
}

export function deleteStorySession(expectedRevision: number | null): Promise<void>;
export function deleteStorySession(
  conversationId: string,
  expectedRevision: number | null,
): Promise<void>;
export async function deleteStorySession(
  conversationIdOrExpectedRevision: string | number | null,
  explicitExpectedRevision?: number | null,
) {
  const conversationId =
    typeof conversationIdOrExpectedRevision === "string"
      ? conversationIdOrExpectedRevision
      : CURRENT;
  const expectedRevision =
    typeof conversationIdOrExpectedRevision === "string"
      ? explicitExpectedRevision!
      : conversationIdOrExpectedRevision;
  const result = await transaction<void>(SESSION_STORE, "readwrite", (tx, abort) => {
    const store = tx.objectStore(SESSION_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      try {
        const record = request.result as unknown;
        const current =
          record === undefined ? null : fromStoredSession(sessionSchema.parse(record));
        if ((current?.revision ?? null) !== expectedRevision) {
          abort(new SessionConflictError());
          return;
        }
        const deletion = store.delete(conversationId);
        deletion.onsuccess = () => setResult(tx, undefined);
      } catch (error) {
        abort(error);
      }
    };
  });
  await deleteDailyStoryReview(conversationId);
  notifySession(conversationId, (expectedRevision ?? 0) + 1);
  return result;
}

export function acquireStoryLease(ownerId: string): Promise<boolean>;
export function acquireStoryLease(conversationId: string, ownerId: string): Promise<boolean>;
export async function acquireStoryLease(first: string, second?: string) {
  const conversationId = second === undefined ? CURRENT : first;
  const ownerId = second === undefined ? first : second;
  return transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      const now = Date.now();
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        setResult(tx, false);
        return;
      }
      const write = store.put({ id: conversationId, ownerId, expiresAt: now + LEASE_MS });
      write.onsuccess = () => setResult(tx, true);
    };
  });
}

/** Claim the newest live connection. Older tabs will become read-only. */
export async function claimStoryLease(conversationId: string, ownerId: string) {
  const claimed = await transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const write = store.put({ id: conversationId, ownerId, expiresAt: Date.now() + LEASE_MS });
    write.onsuccess = () => setResult(tx, true);
  });
  if (claimed) notifyLease(conversationId, ownerId);
  return claimed;
}

export function releaseStoryLease(ownerId: string): Promise<void>;
export function releaseStoryLease(conversationId: string, ownerId: string): Promise<void>;
export async function releaseStoryLease(first: string, second?: string) {
  const conversationId = second === undefined ? CURRENT : first;
  const ownerId = second === undefined ? first : second;
  return transaction<void>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (lease?.ownerId !== ownerId) {
        setResult(tx, undefined);
        return;
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export function subscribeDailyStorage(listener: (event: DailyStorageEvent) => void) {
  listeners.add(listener);
  if (typeof BroadcastChannel !== "undefined") {
    channel ??= new BroadcastChannel("kotoba-daily-story-v1");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      const { kind, conversationId, revision, ownerId } = payload as {
        kind?: unknown;
        conversationId?: unknown;
        revision?: unknown;
        ownerId?: unknown;
      };
      if (kind === "settings" && typeof revision === "number") {
        listeners.forEach((callback) => callback({ kind, revision }));
      } else if (
        kind === "session" &&
        typeof conversationId === "string" &&
        typeof revision === "number"
      ) {
        listeners.forEach((callback) => callback({ kind, conversationId, revision }));
      } else if (
        kind === "lease" &&
        typeof conversationId === "string" &&
        typeof ownerId === "string"
      ) {
        listeners.forEach((callback) => callback({ kind, conversationId, ownerId }));
      }
    };
  }
  return () => listeners.delete(listener);
}
