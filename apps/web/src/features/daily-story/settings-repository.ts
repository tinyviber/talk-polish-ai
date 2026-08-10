import { z } from "zod";
import {
  DAILY_STORY_LIMITS,
  dailyStoryAsrConfigSchema,
  dailyStoryChatConfigSchema,
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
  ProviderSettings,
  StorySession,
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

type StoredSettings = z.infer<typeof settingsSchema>;
type StoredSession = z.infer<typeof sessionSchema>;
type DailyStorageEvent =
  | { kind: "settings"; revision: number }
  | { kind: "session"; conversationId: string; revision: number }
  | { kind: "lease"; conversationId: string; ownerId: string };

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
const listeners = new Set<(event: DailyStorageEvent) => void>();

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
        reset();
        reject(
          new DailyStorageError(
            "浏览器正在阻止设置数据库升级。请关闭其它打开此应用的标签页后重试。",
          ),
        );
      };
      request.onerror = () => {
        reset();
        reject(new DailyStorageError());
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          reset();
        };
        resolve(db);
      };
    });
    const reset = () => {
      if (openPromise === trackedPromise) openPromise = undefined;
    };
    const trackedPromise = pendingPromise.catch((error: unknown) => {
      reset();
      throw error;
    });
    openPromise = trackedPromise;
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
    ...(value.review ? { review: value.review } : {}),
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
  return sessionSchema.parse({ id: conversationId, ...session });
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
        ...(current.tts ? { tts: current.tts } : {}),
        [capability]: validated,
      }) as Omit<ProviderSettings, "schemaVersion" | "revision" | "updatedAt">,
  );
}

/** Test-only seam: close the cached connection so open failure recovery is measurable. */
export async function __resetDailyStorageForTests() {
  const pending = openPromise;
  openPromise = undefined;
  const db = await pending?.catch(() => undefined);
  db?.close();
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
  return transaction<StorySessionSummary[]>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => {
      const sessions = (request.result as unknown[]).map((record) => {
        const parsed = sessionSchema.parse(record);
        return {
          id: parsed.id,
          revision: parsed.revision,
          updatedAt: parsed.updatedAt,
          phase: parsed.phase,
          storyZh: parsed.storyZh,
        } satisfies StorySessionSummary;
      });
      setResult(
        tx,
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    };
  });
}

export async function readStorySession(conversationId = CURRENT): Promise<StorySession | null> {
  return transaction<StorySession | null>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      setResult(tx, record === undefined ? null : fromStoredSession(sessionSchema.parse(record)));
    };
  });
}

/** CAS writes stop stale tabs from undoing newer turns. */
type StorySessionSnapshot = Omit<StorySession, "schemaVersion" | "revision" | "updatedAt">;

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
    (tx) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const leaseRequest = ownerId ? tx.objectStore(LEASE_STORE).get(conversationId) : undefined;
      let storedSessionRecord: StoredSession | undefined;
      let leaseRecord: unknown;
      let sessionReady = false;
      let leaseReady = !ownerId;
      const commit = () => {
        if (!sessionReady || !leaseReady) return;
        if (ownerId) {
          const lease = leaseRecord === undefined ? null : leaseSchema.parse(leaseRecord);
          if (lease?.ownerId !== ownerId) throw new SessionConflictError();
        }
        const previous =
          storedSessionRecord === undefined
            ? null
            : fromStoredSession(sessionSchema.parse(storedSessionRecord));
        if ((previous?.revision ?? null) !== expectedRevision) {
          throw new SessionConflictError();
        }
        const next: StorySession = {
          ...session,
          schemaVersion: 1,
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        const write = store.put(sessionRecord(next, conversationId));
        write.onsuccess = () => setResult(tx, next);
      };
      request.onsuccess = () => {
        storedSessionRecord = request.result as StoredSession | undefined;
        sessionReady = true;
        commit();
      };
      if (leaseRequest) {
        leaseRequest.onsuccess = () => {
          leaseRecord = leaseRequest.result;
          leaseReady = true;
          commit();
        };
      }
    },
  ).catch((error: unknown) => {
    if (error instanceof DailyStorageError) throw error;
    throw new SessionConflictError();
  });
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
  return transaction<void>(SESSION_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SESSION_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const current = record === undefined ? null : fromStoredSession(sessionSchema.parse(record));
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new SessionConflictError();
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  }).catch((error: unknown) => {
    if (error instanceof DailyStorageError) throw error;
    throw new SessionConflictError();
  });
  notifySession(conversationId, (expectedRevision ?? 0) + 1);
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
