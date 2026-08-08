import { z } from "zod";
import type {
  AsrProvider,
  ChatProvider,
  DailyCapability,
  ProviderSettings,
  StorySession,
  TtsProvider,
} from "./types";

const DB_NAME = "kotoba-loop-settings";
const DB_VERSION = 1;
const SETTINGS_STORE = "providerSettings";
const SESSION_STORE = "storySessions";
const LEASE_STORE = "storyLeases";
const CURRENT = "current";
const LEASE_MS = 15_000;

const providerSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().min(1).max(1_000),
    model: z.string().trim().min(1).max(200),
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
      .extend({ responseFormat: z.string().trim().min(1).max(100).optional() })
      .optional(),
    tts: providerSchema.extend({ voice: z.string().trim().min(1).max(200) }).optional(),
  })
  .strict();
const messageSchema = z
  .object({
    id: z.string().min(1).max(160),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1).max(8_000),
    source: z.enum(["asr", "typed"]).optional(),
  })
  .strict();
const sessionSchema = z
  .object({
    id: z.literal(CURRENT),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    phase: z.enum(["chatting", "transcriptReady", "review"]),
    storyZh: z.string().min(1).max(4_000),
    messages: z.array(messageSchema).max(30),
    pendingAsrTranscript: z
      .object({ id: z.string().min(1).max(160), text: z.string().min(1).max(8_000) })
      .strict()
      .optional(),
    review: z
      .object({
        suggestions: z
          .array(
            z
              .object({
                sourceTurnId: z.string().min(1).max(160),
                original: z.string().min(1).max(8_000),
                improved: z.string().min(1).max(8_000),
                // Existing local review snapshots predate category. Defaulting
                // keeps them recoverable; next write stores the explicit value.
                category: z.enum(["clarity", "grammar", "naturalness"]).default("naturalness"),
                explanationZh: z.string().min(1).max(1_000),
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
    id: z.literal(CURRENT),
    ownerId: z.string().min(1).max(160),
    expiresAt: z.number().int().positive(),
  })
  .strict();

type StoredSettings = z.infer<typeof settingsSchema>;
type StoredSession = z.infer<typeof sessionSchema>;

export class DailyStorageError extends Error {
  constructor(message = "当前浏览器无法安全保存 API 配置。请允许此网站使用 IndexedDB 后重试。") {
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

let openPromise: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
const listeners = new Set<(event: { kind: "settings" | "session"; revision: number }) => void>();

function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new DailyStorageError());
  if (!openPromise) {
    openPromise = new Promise<IDBDatabase>((resolve, reject) => {
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
      request.onblocked = () =>
        reject(
          new DailyStorageError(
            "浏览器正在阻止设置数据库升级。请关闭其它打开此应用的标签页后重试。",
          ),
        );
      request.onerror = () => reject(new DailyStorageError());
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  return openPromise;
}

function transaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => void,
) {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let tx: IDBTransaction;
        try {
          tx = db.transaction(stores, mode);
          run(tx);
        } catch {
          reject(new DailyStorageError());
          return;
        }
        tx.oncomplete = () => resolve(result!);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new DailyStorageError());
        (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult = (value) => {
          result = value;
        };
      }),
  );
}

function setResult<T>(tx: IDBTransaction, value: T) {
  (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult?.(value);
}

function notify(kind: "settings" | "session", revision: number) {
  if (typeof BroadcastChannel === "undefined") return;
  channel ??= new BroadcastChannel("kotoba-daily-story-v1");
  channel.postMessage({ kind, revision });
}

function fromStoredSettings(value: StoredSettings): ProviderSettings {
  const asr = value.asr
    ? {
        baseUrl: value.asr.baseUrl,
        apiKey: value.asr.apiKey,
        model: value.asr.model,
        ...(value.asr.responseFormat ? { responseFormat: value.asr.responseFormat } : {}),
      }
    : undefined;
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(value.chat ? { chat: value.chat } : {}),
    ...(asr ? { asr } : {}),
    ...(value.tts ? { tts: value.tts } : {}),
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
    ...(value.review ? { review: value.review } : {}),
  };
}

function settingsRecord(settings: ProviderSettings): StoredSettings {
  return settingsSchema.parse({ id: CURRENT, ...settings });
}

function sessionRecord(session: StorySession): StoredSession {
  return sessionSchema.parse({ id: CURRENT, ...session });
}

export async function ensureDailyStorage() {
  await database();
}

export async function readProviderSettings(): Promise<ProviderSettings> {
  const result = await transaction<ProviderSettings>(SETTINGS_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SETTINGS_STORE).get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const defaultSettings: ProviderSettings = {
        schemaVersion: 1,
        revision: 0,
        updatedAt: new Date(0).toISOString(),
      };
      setResult(
        tx,
        record === undefined ? defaultSettings : fromStoredSettings(settingsSchema.parse(record)),
      );
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
  notify("settings", result.revision);
  return result;
}

export function saveProvider(
  capability: DailyCapability,
  provider: ProviderSettings[DailyCapability],
) {
  if (!provider) throw new DailyStorageError("配置不完整，无法保存。");
  return writeProviderSettings(
    (current) =>
      ({
        ...(current.chat ? { chat: current.chat } : {}),
        ...(current.asr ? { asr: current.asr } : {}),
        ...(current.tts ? { tts: current.tts } : {}),
        [capability]: provider,
      }) as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
  );
}

export function clearProvider(capability: DailyCapability) {
  return writeProviderSettings((current) => {
    const next: { chat?: ChatProvider; asr?: AsrProvider; tts?: TtsProvider } = {
      ...(current.chat ? { chat: current.chat } : {}),
      ...(current.asr ? { asr: current.asr } : {}),
      ...(current.tts ? { tts: current.tts } : {}),
    };
    delete next[capability];
    return next as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">;
  });
}

export function clearAllProviders() {
  return writeProviderSettings(() => ({}));
}

export async function readStorySession(): Promise<StorySession | null> {
  return transaction<StorySession | null>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      setResult(tx, record === undefined ? null : fromStoredSession(sessionSchema.parse(record)));
    };
  });
}

/** CAS writes stop stale tabs from undoing newer turns. */
export async function writeStorySession(
  session: Omit<StorySession, "schemaVersion" | "revision" | "updatedAt">,
  expectedRevision: number | null,
): Promise<StorySession> {
  const result = await transaction<StorySession>(SESSION_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SESSION_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const previous = record === undefined ? null : fromStoredSession(sessionSchema.parse(record));
      if ((previous?.revision ?? null) !== expectedRevision) {
        throw new SessionConflictError();
      }
      const next: StorySession = {
        ...session,
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      const write = store.put(sessionRecord(next));
      write.onsuccess = () => setResult(tx, next);
    };
  }).catch((error: unknown) => {
    if (error instanceof DailyStorageError) throw error;
    throw new SessionConflictError();
  });
  notify("session", result.revision);
  return result;
}

export async function deleteStorySession(expectedRevision: number | null) {
  return transaction<void>(SESSION_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SESSION_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const current = record === undefined ? null : fromStoredSession(sessionSchema.parse(record));
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new SessionConflictError();
      }
      const deletion = store.delete(CURRENT);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  }).catch((error: unknown) => {
    if (error instanceof DailyStorageError) throw error;
    throw new SessionConflictError();
  });
  notify("session", (expectedRevision ?? 0) + 1);
}

export async function acquireStoryLease(ownerId: string) {
  return transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      const now = Date.now();
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        setResult(tx, false);
        return;
      }
      const write = store.put({ id: CURRENT, ownerId, expiresAt: now + LEASE_MS });
      write.onsuccess = () => setResult(tx, true);
    };
  });
}

export async function releaseStoryLease(ownerId: string) {
  return transaction<void>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (lease?.ownerId !== ownerId) {
        setResult(tx, undefined);
        return;
      }
      const deletion = store.delete(CURRENT);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export function subscribeDailyStorage(
  listener: (event: { kind: "settings" | "session"; revision: number }) => void,
) {
  listeners.add(listener);
  if (typeof BroadcastChannel !== "undefined") {
    channel ??= new BroadcastChannel("kotoba-daily-story-v1");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      const { kind, revision } = payload as { kind?: unknown; revision?: unknown };
      if ((kind === "settings" || kind === "session") && typeof revision === "number") {
        listeners.forEach((callback) => callback({ kind, revision }));
      }
    };
  }
  return () => listeners.delete(listener);
}
