import type { Lang } from "./types";

export type QueueStatus =
  "recorded-unsent" | "queued" | "uploading" | "processing" | "ready" | "failed";
export type RecordingQueueItem = {
  /** Learner namespace; prevents a later token/device from reading old blobs. */
  learnerId: string;
  clientAttemptId: string;
  /** Server session id once known; null while the session was created offline. */
  sessionId: string | null;
  /** Client-generated session idempotency key, used to create the session on reconnect. */
  clientSessionId: string;
  promptId: string;
  /** Display copy retained so a restored draft never appears under a different prompt. */
  promptText?: string;
  lang: Lang;
  attemptIndex: 1 | 2;
  duration: number;
  mimeType: string;
  blob: Blob;
  createdAt: number;
  syncStatus: QueueStatus;
  attemptId?: string;
  lastError?: string;
  /** Do not retry a still-processing attempt before this time. */
  nextPollAt?: number;
  /** Bytes are dropped once the attempt is safely stored server-side. */
  blobDiscarded?: boolean;
};

export type SyncableRecordingQueueItem = Omit<RecordingQueueItem, "syncStatus"> & {
  syncStatus: Exclude<QueueStatus, "recorded-unsent">;
};

export function isQueueSyncCandidate(status: QueueStatus) {
  return status === "queued" || status === "processing";
}

export function recoverQueueStatus(status: QueueStatus): QueueStatus {
  return status === "uploading" ? "queued" : status;
}

const DB_NAME = "kotoba-loop-offline";
const STORE = "recordings";
const LOCK_STORE = "locks";
const SYNC_LOCK_KEY = "recording-queue";
const SYNC_LOCK_TTL_MS = 30_000;
const SYNC_LOCK_RENEWAL_MS = 10_000;
const DB_VERSION = 3;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;
const PROCESSING_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const PROCESSING_RETRY_DELAY_MS = 15_000;
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase> | null = null;
let queueChannel: BroadcastChannel | null = null;

function broadcastQueueChange() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  queueChannel ??= new BroadcastChannel("kotoba-recording-queue");
  queueChannel.postMessage("change");
}

function notify() {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") window.dispatchEvent(new Event("kotoba:queue-change"));
  broadcastQueueChange();
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  const existing = dbPromise;
  if (existing) return existing;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const existed = request.result.objectStoreNames.contains(STORE);
      if (!existed) {
        request.result.createObjectStore(STORE, { keyPath: "clientAttemptId" });
      } else {
        // v1 items had no learner namespace. Keep their bytes isolated and
        // visible only to cleanup, rather than ever uploading them as another
        // learner after a token/device change.
        const store = request.transaction?.objectStore(STORE);
        if (store) {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            if (!value["learnerId"]) {
              cursor.update({
                ...value,
                learnerId: "legacy",
                syncStatus: "failed",
                lastError: "This recording needs to be re-recorded after the app update.",
              });
            }
            cursor.continue();
          };
        }
      }
      if (!request.result.objectStoreNames.contains(LOCK_STORE)) {
        request.result.createObjectStore(LOCK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer tab upgrade the database instead of keeping the old
      // connection open and blocking the migration forever.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("IndexedDB unavailable"));
    };
    request.onblocked = () => {
      // Existing connections close themselves through onversionchange.
      // Keep the request pending so the browser can complete the upgrade.
    };
  }).catch((error) => {
    if (dbPromise === promise) dbPromise = null;
    throw error;
  });
  dbPromise = promise;
  return promise;
}

async function allItems() {
  if (typeof indexedDB === "undefined") return [] as RecordingQueueItem[];
  const db = await openDb();
  return new Promise<RecordingQueueItem[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as RecordingQueueItem[]);
    request.onerror = () => reject(request.error);
  });
}

async function put(item: RecordingQueueItem) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite") as IDBTransaction;
    const waitForTransaction = "oncomplete" in transaction;
    const request = transaction.objectStore(STORE).put(item);
    request.onsuccess = () => {
      // Real IndexedDB can still abort after the request succeeds. Wait for
      // the transaction when the implementation exposes that lifecycle.
      if (!waitForTransaction) resolve();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
  notify();
}

async function remove(clientAttemptId: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite") as IDBTransaction;
    const waitForTransaction = "oncomplete" in transaction;
    const request = transaction.objectStore(STORE).delete(clientAttemptId);
    request.onsuccess = () => {
      if (!waitForTransaction) resolve();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB delete failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB delete aborted"));
  });
  notify();
}

export async function cleanupRecordingQueue(now = Date.now()) {
  const items = await allItems();
  // Never silently delete a recording that still needs upload or processing.
  const expired = items.filter(
    (item) =>
      now - item.createdAt > TTL_MS &&
      (item.syncStatus === "ready" || item.syncStatus === "failed"),
  );
  for (const item of expired) await remove(item.clientAttemptId);
}

/** Recover a tab that was suspended after marking an item uploading. */
export async function recoverInterruptedUploads() {
  const items = await allItems();
  for (const item of items.filter((candidate) => candidate.syncStatus === "uploading")) {
    const { lastError: _lastError, ...withoutError } = item;
    await put({ ...withoutError, syncStatus: recoverQueueStatus(item.syncStatus) });
  }
}

export async function enqueueRecording(input: Omit<RecordingQueueItem, "syncStatus">) {
  if (!input.learnerId || input.learnerId === "legacy") {
    throw new Error("Learner session is unavailable; recording was not queued.");
  }
  await cleanupRecordingQueue();
  const existing = await allItems();
  // Synced recordings keep only metadata, so they never consume the quota.
  const totalBytes = existing
    .filter((item) => item.syncStatus !== "ready" && item.clientAttemptId !== input.clientAttemptId)
    .reduce((sum, item) => sum + item.blob.size, 0);
  if (totalBytes + input.blob.size > MAX_BYTES) {
    throw new Error("Offline recording storage is full. Retry or remove an older recording first.");
  }
  await put({ ...input, syncStatus: "queued" });
  return input.clientAttemptId;
}

/** Persist a completed take before the learner decides whether to submit it. */
export async function saveRecordingDraft(input: Omit<RecordingQueueItem, "syncStatus">) {
  if (!input.learnerId || input.learnerId === "legacy") {
    throw new Error("Learner session is unavailable; recording was not saved.");
  }
  await cleanupRecordingQueue();
  const existing = await allItems();
  const totalBytes = existing
    .filter((item) => item.syncStatus !== "ready" && item.clientAttemptId !== input.clientAttemptId)
    .reduce((sum, item) => sum + item.blob.size, 0);
  if (totalBytes + input.blob.size > MAX_BYTES) {
    throw new Error("Recording storage is full. Remove an older recording and try again.");
  }
  await put({ ...input, syncStatus: "recorded-unsent" });
  return input.clientAttemptId;
}

export async function deleteRecording(clientAttemptId: string) {
  await remove(clientAttemptId);
}

export async function listRecordingQueue(learnerId?: string) {
  if (!learnerId) return [] as RecordingQueueItem[];
  return (await allItems()).filter((item) => item.learnerId === learnerId);
}

export function subscribeRecordingQueue(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    queueChannel ??= new BroadcastChannel("kotoba-recording-queue");
    queueChannel.addEventListener("message", listener);
  }
  return () => {
    listeners.delete(listener);
    queueChannel?.removeEventListener("message", listener);
  };
}

export async function retryQueuedRecordings(learnerId?: string) {
  if (!learnerId) return;
  const items = (await allItems()).filter((item) => item.learnerId === learnerId);
  await Promise.all(
    items
      .filter((item) => item.syncStatus === "failed")
      .map((item) => {
        const { lastError: _lastError, ...withoutError } = item;
        return put({ ...withoutError, syncStatus: "queued" });
      }),
  );
}

export type QueueUploadResult = {
  id: string;
  status: QueueStatus;
  /** Returned when the session had to be created during the upload. */
  sessionId?: string;
};

let syncInFlight: Promise<void> | null = null;
let syncRequested = false;
let syncRequestedLearnerId: string | null = null;
let processingPollTimer: ReturnType<typeof setTimeout> | null = null;
let syncGeneration = 0;

function clearProcessingPollTimer() {
  if (processingPollTimer) clearTimeout(processingPollTimer);
  processingPollTimer = null;
}

export function cancelScheduledRecordingQueueSync() {
  syncGeneration += 1;
  clearProcessingPollTimer();
}

function scheduleProcessingPoll(
  upload: (item: SyncableRecordingQueueItem) => Promise<QueueUploadResult>,
  learnerId: string,
  delayMs = PROCESSING_RETRY_DELAY_MS,
  generation = syncGeneration,
) {
  clearProcessingPollTimer();
  if (generation !== syncGeneration) return;
  const timerGeneration = generation;
  processingPollTimer = setTimeout(() => {
    processingPollTimer = null;
    if (timerGeneration !== syncGeneration) return;
    void syncRecordingQueue(upload, learnerId);
  }, delayMs);
}

type ReleaseSyncLock = () => Promise<void>;

async function renewIndexedDbSyncLock(db: IDBDatabase, owner: string) {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = db.transaction(LOCK_STORE, "readwrite");
    const store = transaction.objectStore(LOCK_STORE);
    const request = store.get(SYNC_LOCK_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const current = request.result as { owner?: string } | undefined;
      if (current?.owner !== owner) {
        transaction.abort();
        resolve(false);
        return;
      }
      store.put({
        key: SYNC_LOCK_KEY,
        owner,
        expiresAt: Date.now() + SYNC_LOCK_TTL_MS,
      });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => resolve(false);
    };
  });
}

async function acquireIndexedDbSyncLock(): Promise<ReleaseSyncLock | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDb().catch(() => null);
  if (!db) return null;
  const owner =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  for (;;) {
    const acquired = await new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(LOCK_STORE, "readwrite");
      const store = transaction.objectStore(LOCK_STORE);
      const request = store.get(SYNC_LOCK_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result as { owner?: string; expiresAt?: number } | undefined;
        if (current?.owner && current.owner !== owner && (current.expiresAt ?? 0) > Date.now()) {
          transaction.abort();
          resolve(false);
          return;
        }
        store.put({
          key: SYNC_LOCK_KEY,
          owner,
          expiresAt: Date.now() + SYNC_LOCK_TTL_MS,
        });
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error);
      };
    });
    if (acquired) {
      let released = false;
      let renewalInFlight: Promise<boolean> | null = null;
      const renewalTimer = setInterval(() => {
        if (released || renewalInFlight) return;
        renewalInFlight = renewIndexedDbSyncLock(db, owner)
          .catch(() => false)
          .finally(() => {
            renewalInFlight = null;
          });
        void renewalInFlight;
      }, SYNC_LOCK_RENEWAL_MS);
      return async () => {
        released = true;
        clearInterval(renewalTimer);
        await renewalInFlight;
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(LOCK_STORE, "readwrite");
          const store = transaction.objectStore(LOCK_STORE);
          const request = store.get(SYNC_LOCK_KEY);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const current = request.result as { owner?: string } | undefined;
            if (current?.owner === owner) store.delete(SYNC_LOCK_KEY);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
        });
      };
    }
    await wait(100);
  }
}

async function withCrossTabSyncLock(work: () => Promise<void>) {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request("kotoba-recording-queue-sync", { mode: "exclusive" }, work);
  }
  const release = await acquireIndexedDbSyncLock();
  if (!release) return work();
  try {
    return await work();
  } finally {
    await release();
  }
}

/** Deterministic ordering is important even when IndexedDB returns insertion order today. */
export function orderQueueItems(items: RecordingQueueItem[]) {
  return [...items].sort((left, right) => {
    const leftSession = left.sessionId ?? left.clientSessionId;
    const rightSession = right.sessionId ?? right.clientSessionId;
    return (
      leftSession.localeCompare(rightSession) ||
      left.attemptIndex - right.attemptIndex ||
      left.createdAt - right.createdAt ||
      left.clientAttemptId.localeCompare(right.clientAttemptId)
    );
  });
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransientUploadError(error: unknown) {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (status === 0 || status === 408 || status === 429 || (status !== undefined && status >= 500))
    return true;
  const message = error instanceof Error ? error.message : "";
  return error instanceof TypeError || /network|reach|offline|timeout|aborted/i.test(message);
}

async function uploadWithProcessingPoll(
  item: SyncableRecordingQueueItem,
  upload: (item: SyncableRecordingQueueItem) => Promise<QueueUploadResult>,
) {
  let current = await upload(item);
  for (const delay of PROCESSING_POLL_DELAYS_MS) {
    if (current.status !== "processing") return current;
    await wait(delay);
    current = await upload({
      ...item,
      attemptId: current.id,
      syncStatus: "processing",
    });
  }
  return current;
}

async function syncRecordingQueueOnce(
  upload: (item: SyncableRecordingQueueItem) => Promise<QueueUploadResult>,
  learnerId?: string,
  generation = syncGeneration,
) {
  if (!learnerId || (typeof navigator !== "undefined" && !navigator.onLine)) return;
  await recoverInterruptedUploads();
  await cleanupRecordingQueue();
  const now = Date.now();
  const queueItems = (await allItems()).filter(
    (item) => item.learnerId === learnerId && isQueueSyncCandidate(item.syncStatus),
  ) as SyncableRecordingQueueItem[];
  const nextPollAt = queueItems
    .map((item) => item.nextPollAt)
    .filter((value): value is number => typeof value === "number" && value > now)
    .sort((left, right) => left - right)[0];
  if (nextPollAt !== undefined) {
    scheduleProcessingPoll(upload, learnerId, nextPollAt - now, generation);
  }
  const items = orderQueueItems(
    queueItems.filter((item) => !item.nextPollAt || item.nextPollAt <= now),
  );
  const blockedSessions = new Set<string>();
  for (const item of items) {
    const sessionKey = item.sessionId ?? item.clientSessionId;
    // Attempt 2 must never race past an attempt 1 which is still processing
    // (or whose response was lost). A later sync will query/replay attempt 1.
    if (blockedSessions.has(sessionKey)) continue;
    try {
      const { nextPollAt: _nextPollAt, ...withoutNextPollAt } = item;
      const syncing = {
        ...withoutNextPollAt,
        syncStatus: item.syncStatus === "processing" ? "processing" : "uploading",
      } as SyncableRecordingQueueItem;
      await put(syncing);
      const attempt = await uploadWithProcessingPoll(syncing, upload);
      const { lastError: _lastError, ...withoutError } = syncing;
      const synced = attempt.status === "ready";
      const stored = {
        ...withoutError,
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
        attemptId: attempt.id,
        syncStatus: attempt.status,
        // Free the device once the server owns the recording; the metadata
        // row stays so the UI can still report the completed upload.
        ...(synced
          ? { blob: new Blob([], { type: withoutError.mimeType }), blobDiscarded: true }
          : {}),
      } as RecordingQueueItem;
      if (attempt.status === "processing") {
        await put({
          ...stored,
          syncStatus: "processing",
          nextPollAt: Date.now() + PROCESSING_RETRY_DELAY_MS,
        });
        scheduleProcessingPoll(upload, learnerId, PROCESSING_RETRY_DELAY_MS, generation);
      } else {
        await put(stored);
      }
      if (attempt.status !== "ready") blockedSessions.add(sessionKey);
      if (attempt.status === "ready" && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("kotoba:queue-ready", {
            detail: {
              learnerId: item.learnerId,
              clientAttemptId: item.clientAttemptId,
              sessionId: attempt.sessionId ?? item.sessionId,
              clientSessionId: item.clientSessionId,
              attemptIndex: item.attemptIndex,
              attemptId: attempt.id,
            },
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      // Network/5xx failures can resume automatically. Permanent 4xx and
      // validation failures stay failed until the user explicitly retries.
      const transient = isTransientUploadError(error);
      await put({
        ...item,
        syncStatus: transient ? "queued" : "failed",
        lastError: message,
        ...(transient ? { nextPollAt: Date.now() + PROCESSING_RETRY_DELAY_MS } : {}),
      });
      blockedSessions.add(sessionKey);
      if (transient) {
        scheduleProcessingPoll(upload, learnerId, PROCESSING_RETRY_DELAY_MS, generation);
        break;
      }
    }
  }
}

async function syncRecordingQueueLoop(
  upload: (item: SyncableRecordingQueueItem) => Promise<QueueUploadResult>,
  learnerId: string,
) {
  let nextLearnerId = learnerId;
  const generation = syncGeneration;
  for (;;) {
    if (generation !== syncGeneration) return;
    syncRequested = false;
    syncRequestedLearnerId = null;
    await withCrossTabSyncLock(() => syncRecordingQueueOnce(upload, nextLearnerId, generation));
    if (generation !== syncGeneration || !syncRequested) return;
    nextLearnerId = syncRequestedLearnerId ?? nextLearnerId;
  }
}

export function syncRecordingQueue(
  upload: (item: SyncableRecordingQueueItem) => Promise<QueueUploadResult>,
  learnerId?: string,
) {
  if (!learnerId) return Promise.resolve();
  if (syncInFlight) {
    // Queue-change notifications can arrive while a sync is running. Keep
    // one trailing pass so newly queued items and final processing states are
    // never lost when the current promise is reused.
    syncRequested = true;
    syncRequestedLearnerId = learnerId;
    return syncInFlight;
  }
  const inFlight = syncRecordingQueueLoop(upload, learnerId).finally(() => {
    if (syncInFlight === inFlight) syncInFlight = null;
  });
  syncInFlight = inFlight;
  return inFlight;
}
