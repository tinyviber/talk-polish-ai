import type { Lang } from "./types";

export type QueueStatus =
  "local-draft" | "queued" | "uploading" | "processing" | "ready" | "failed";
export type RecordingQueueItem = {
  /** Learner namespace; prevents a later token/device from reading old blobs. */
  learnerId: string;
  clientAttemptId: string;
  /** Server session id once known; null while the session was created offline. */
  sessionId: string | null;
  /** Client-generated session idempotency key, used to create the session on reconnect. */
  clientSessionId: string;
  promptId: string;
  lang: Lang;
  attemptIndex: 1 | 2;
  duration: number;
  mimeType: string;
  blob: Blob;
  createdAt: number;
  syncStatus: QueueStatus;
  attemptId?: string | undefined;
  lastError?: string | undefined;
  /** Bytes are dropped once the attempt is safely stored server-side. */
  blobDiscarded?: boolean | undefined;
  /** Durable wake-up time for future processing polls and transient retries. */
  nextPollAt?: number | undefined;
  /** Exponential backoff step while the server is still processing. */
  processingPollIndex?: number | undefined;
  /** Exponential backoff step after a transient upload/read failure. */
  transientRetryIndex?: number | undefined;
};

export function isQueueSyncCandidate(status: QueueStatus) {
  return status === "queued" || status === "processing";
}

export function recoverQueueStatus(status: QueueStatus): QueueStatus {
  return status === "uploading" ? "queued" : status;
}

const DB_NAME = "kotoba-loop-offline";
const STORE = "recordings";
const LEASE_STORE = "syncLeases";
const DB_VERSION = 3;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;
const LEASE_MS = 30_000;
const PROCESSING_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase> | null = null;
let queueChannel: BroadcastChannel | null = null;
let syncOwnerId: string | null = null;
let syncTrailingPassRequested = false;

function ensureQueueChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
  queueChannel ??= new BroadcastChannel("kotoba-loop-recording-queue");
  queueChannel.onmessage ??= () => {
    listeners.forEach((listener) => listener());
    if (typeof window !== "undefined") window.dispatchEvent(new Event("kotoba:queue-change"));
  };
  return queueChannel;
}

function broadcastChange() {
  ensureQueueChannel()?.postMessage({ type: "queue-change" });
}

function notify() {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") window.dispatchEvent(new Event("kotoba:queue-change"));
  broadcastChange();
}

export function orderRecordingQueue(items: RecordingQueueItem[]) {
  return [...items].sort(
    (a, b) => a.createdAt - b.createdAt || a.clientAttemptId.localeCompare(b.clientAttemptId),
  );
}

export function canSyncAttempt(item: RecordingQueueItem, items: RecordingQueueItem[]) {
  if (item.attemptIndex === 1) return true;
  return items.some(
    (candidate) =>
      candidate.learnerId === item.learnerId &&
      candidate.clientSessionId === item.clientSessionId &&
      candidate.attemptIndex === 1 &&
      candidate.syncStatus === "ready",
  );
}

function normalizeLearnerIds(learnerIds?: string | string[]) {
  return [...new Set(Array.isArray(learnerIds) ? learnerIds : learnerIds ? [learnerIds] : [])];
}

function getBackoffDelay(delays: readonly number[], index?: number) {
  return delays[Math.min(index ?? 0, delays.length - 1)]!;
}

function clearDeferredSyncState(item: RecordingQueueItem): RecordingQueueItem {
  return {
    ...item,
    nextPollAt: undefined,
    processingPollIndex: undefined,
    transientRetryIndex: undefined,
  };
}

function scheduleProcessingPoll(item: RecordingQueueItem, now = Date.now()): RecordingQueueItem {
  const processingPollIndex = item.processingPollIndex ?? 0;
  return {
    ...item,
    syncStatus: "processing",
    lastError: undefined,
    nextPollAt: now + getBackoffDelay(PROCESSING_POLL_DELAYS_MS, processingPollIndex),
    processingPollIndex: processingPollIndex + 1,
    transientRetryIndex: undefined,
  };
}

function scheduleTransientRetry(
  item: RecordingQueueItem,
  message: string,
  now = Date.now(),
): RecordingQueueItem {
  const recoveredStatus = recoverQueueStatus(item.syncStatus);
  const transientRetryIndex = item.transientRetryIndex ?? 0;
  return {
    ...item,
    syncStatus: recoveredStatus,
    lastError: message,
    nextPollAt: now + getBackoffDelay(TRANSIENT_RETRY_DELAYS_MS, transientRetryIndex),
    processingPollIndex:
      recoveredStatus === "processing" ? (item.processingPollIndex ?? 0) : undefined,
    transientRetryIndex: transientRetryIndex + 1,
  };
}

function queueSchedulableItems(
  items: RecordingQueueItem[],
  learnerIds?: string | string[],
): RecordingQueueItem[] {
  const queueLearnerIds = normalizeLearnerIds(learnerIds);
  if (queueLearnerIds.length === 0) return [];
  const readySessionKeys = new Set(
    items
      .filter(
        (item) =>
          learnerMatches(item, queueLearnerIds) &&
          item.attemptIndex === 1 &&
          item.syncStatus === "ready",
      )
      .map((item) => item.clientSessionId),
  );
  return orderRecordingQueue(items).filter((item) => {
    if (!learnerMatches(item, queueLearnerIds) || !isQueueSyncCandidate(item.syncStatus))
      return false;
    return item.attemptIndex === 1 || readySessionKeys.has(item.clientSessionId);
  });
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
      if (!existed) request.result.createObjectStore(STORE, { keyPath: "clientAttemptId" });
      if (!request.result.objectStoreNames.contains(LEASE_STORE)) {
        request.result.createObjectStore(LEASE_STORE, { keyPath: "learnerId" });
      }
      if (!existed) return;
      // v1 items had no learner namespace. Keep their bytes isolated and
      // visible only to cleanup, rather than ever uploading them as another
      // learner after a token/device change.
      const store = request.transaction?.objectStore(STORE);
      if (!store) return;
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
    request.onsuccess = () => resolve(orderRecordingQueue(request.result as RecordingQueueItem[]));
    request.onerror = () => reject(request.error);
  });
}

function waitForTransactionWrite<T>(request: IDBRequest<T>, tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    tx.oncomplete = () => finish(resolve);
    tx.onerror = () =>
      finish(() => reject(tx.error ?? request.error ?? new Error("IndexedDB write failed")));
    tx.onabort = () =>
      finish(() => reject(tx.error ?? request.error ?? new Error("IndexedDB write aborted")));
    request.onerror = () =>
      finish(() => reject(request.error ?? tx.error ?? new Error("IndexedDB write failed")));
  });
}

async function put(item: RecordingQueueItem) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const request = tx.objectStore(STORE).put(item);
  await waitForTransactionWrite(request, tx);
  notify();
}

async function remove(clientAttemptId: string) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const request = tx.objectStore(STORE).delete(clientAttemptId);
  await waitForTransactionWrite(request, tx);
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
    await put({
      ...clearDeferredSyncState(item),
      syncStatus: recoverQueueStatus(item.syncStatus),
      lastError: undefined,
    });
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
    .filter((item) => item.syncStatus !== "ready")
    .reduce((sum, item) => sum + item.blob.size, 0);
  if (totalBytes + input.blob.size > MAX_BYTES) {
    throw new Error("Offline recording storage is full. Retry or remove an older recording first.");
  }
  await put({ ...input, syncStatus: "queued" });
  return input.clientAttemptId;
}

export async function markRecordingReady(
  clientAttemptId: string,
  input: { sessionId?: string; attemptId: string },
) {
  const item = (await allItems()).find(
    (candidate) => candidate.clientAttemptId === clientAttemptId,
  );
  if (!item) return;
  await put({
    ...clearDeferredSyncState(item),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    attemptId: input.attemptId,
    syncStatus: "ready",
    lastError: undefined,
    blob: new Blob([], { type: item.mimeType }),
    blobDiscarded: true,
  });
}

export async function markRecordingFailed(clientAttemptId: string, message: string) {
  const item = (await allItems()).find(
    (candidate) => candidate.clientAttemptId === clientAttemptId,
  );
  if (!item) return;
  await put({
    ...clearDeferredSyncState(item),
    syncStatus: "failed",
    lastError: message,
  });
}

export async function removeQueuedRecording(clientAttemptId: string) {
  if (typeof indexedDB === "undefined") return;
  await remove(clientAttemptId);
}

function learnerMatches(item: RecordingQueueItem, learnerIds: string | string[] | undefined) {
  if (!learnerIds) return false;
  return (Array.isArray(learnerIds) ? learnerIds : [learnerIds]).includes(item.learnerId);
}

export async function listRecordingQueue(learnerIds?: string | string[]) {
  if (!learnerIds || (Array.isArray(learnerIds) && learnerIds.length === 0)) {
    return [] as RecordingQueueItem[];
  }
  return (await allItems()).filter((item) => learnerMatches(item, learnerIds));
}

export function subscribeRecordingQueue(listener: () => void) {
  listeners.add(listener);
  ensureQueueChannel();
  return () => {
    listeners.delete(listener);
  };
}

export async function retryQueuedRecordings(learnerIds?: string | string[]) {
  if (!learnerIds || (Array.isArray(learnerIds) && learnerIds.length === 0)) return;
  const items = (await allItems()).filter((item) => learnerMatches(item, learnerIds));
  await Promise.all(
    items
      .filter((item) => item.syncStatus === "failed")
      .map((item) =>
        put({
          ...clearDeferredSyncState(item),
          syncStatus: "queued",
          lastError: undefined,
        }),
      ),
  );
}

export type QueueUploadResult = {
  id: string;
  status: Exclude<QueueStatus, "local-draft">;
  /** Returned when the session had to be created during the upload. */
  sessionId?: string;
};

let syncInFlight: Promise<void> | null = null;

function getSyncOwnerId() {
  syncOwnerId ??=
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `sync-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return syncOwnerId;
}

async function acquireSyncLease(learnerId: string) {
  const db = await openDb();
  const ownerId = getSyncOwnerId();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    const store = tx.objectStore(LEASE_STORE);
    let acquired = false;
    const request = store.get(learnerId);
    request.onsuccess = () => {
      const current = request.result as
        { learnerId: string; ownerId: string; expiresAt: number } | undefined;
      if (current && current.ownerId !== ownerId && current.expiresAt > Date.now()) return;
      store.put({ learnerId, ownerId, expiresAt: Date.now() + LEASE_MS });
      acquired = true;
    };
    tx.oncomplete = () => resolve(acquired);
    tx.onerror = () => reject(tx.error ?? new Error("Could not acquire recording sync lease."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not acquire recording sync lease."));
  });
}

async function releaseSyncLease(learnerId: string) {
  const db = await openDb();
  const ownerId = getSyncOwnerId();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(learnerId);
    request.onsuccess = () => {
      const current = request.result as { ownerId?: string } | undefined;
      if (current?.ownerId === ownerId) store.delete(learnerId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not release recording sync lease."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not release recording sync lease."));
  });
}

async function renewSyncLease(learnerId: string) {
  const db = await openDb();
  const ownerId = getSyncOwnerId();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    const store = tx.objectStore(LEASE_STORE);
    let renewed = false;
    const request = store.get(learnerId);
    request.onsuccess = () => {
      const current = request.result as { ownerId?: string } | undefined;
      if (current?.ownerId !== ownerId) return;
      store.put({ learnerId, ownerId, expiresAt: Date.now() + LEASE_MS });
      renewed = true;
    };
    tx.oncomplete = () => resolve(renewed);
    tx.onerror = () => reject(tx.error ?? new Error("Could not renew recording sync lease."));
    tx.onabort = () => reject(tx.error ?? new Error("Could not renew recording sync lease."));
  });
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

export async function getNextRecordingQueuePollAt(
  learnerIds?: string | string[],
  now = Date.now(),
) {
  const items = queueSchedulableItems(await allItems(), learnerIds);
  if (items.length === 0) return null;
  return items.reduce<number>(
    (earliest, item) => Math.min(earliest, item.nextPollAt ?? now),
    Number.POSITIVE_INFINITY,
  );
}

export function getRecordingQueueLeaseKey(learnerIds?: string | string[]) {
  const queueLearnerIds = normalizeLearnerIds(learnerIds).sort();
  const deviceNamespace = queueLearnerIds.find((learnerId) => learnerId.startsWith("device:"));
  return deviceNamespace ?? queueLearnerIds.join("|");
}

export async function syncRecordingQueue(
  upload: (item: RecordingQueueItem) => Promise<QueueUploadResult>,
  learnerIds?: string | string[],
) {
  if (syncInFlight) {
    syncTrailingPassRequested = true;
    return syncInFlight;
  }
  const run = async () => {
    if (
      !learnerIds ||
      (Array.isArray(learnerIds) && learnerIds.length === 0) ||
      (typeof navigator !== "undefined" && !navigator.onLine)
    )
      return;
    const queueLearnerIds = normalizeLearnerIds(learnerIds);
    await recoverInterruptedUploads();
    await cleanupRecordingQueue();
    const queueItems = orderRecordingQueue(await allItems());
    const items = queueItems.filter(
      (item) => learnerMatches(item, queueLearnerIds) && isQueueSyncCandidate(item.syncStatus),
    );
    const readySessionKeys = new Set(
      queueItems
        .filter((item) => learnerMatches(item, queueLearnerIds))
        .filter((item) => item.attemptIndex === 1 && item.syncStatus === "ready")
        .map((item) => item.clientSessionId),
    );
    const now = Date.now();
    for (const item of items) {
      if (item.nextPollAt !== undefined && item.nextPollAt > now) continue;
      if (item.attemptIndex === 2 && !readySessionKeys.has(item.clientSessionId)) continue;
      try {
        const syncing =
          item.syncStatus === "processing"
            ? item
            : ({
                ...clearDeferredSyncState(item),
                syncStatus: "uploading",
                lastError: undefined,
              } as RecordingQueueItem);
        if (syncing !== item) await put(syncing);
        const attempt = await upload(syncing);
        const synced = attempt.status === "ready";
        const nextItem =
          attempt.status === "processing"
            ? {
                ...scheduleProcessingPoll(syncing),
                ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
                attemptId: attempt.id,
              }
            : {
                ...clearDeferredSyncState(syncing),
                ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
                attemptId: attempt.id,
                syncStatus: attempt.status,
                lastError: undefined,
                // Free the device once the server owns the recording; the metadata
                // row stays so the UI can still report the completed upload.
                ...(synced
                  ? { blob: new Blob([], { type: syncing.mimeType }), blobDiscarded: true }
                  : {}),
              };
        await put({
          ...nextItem,
        });
        if (attempt.status === "ready") {
          if (item.attemptIndex === 1) readySessionKeys.add(item.clientSessionId);
        }
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
        await put(
          isTransientUploadError(error)
            ? scheduleTransientRetry(
                item.syncStatus === "processing"
                  ? item
                  : ({
                      ...clearDeferredSyncState(item),
                      syncStatus: "uploading",
                      lastError: undefined,
                    } as RecordingQueueItem),
                message,
              )
            : {
                ...clearDeferredSyncState(item),
                syncStatus: "failed",
                lastError: message,
              },
        );
        if (isTransientUploadError(error)) break;
      }
    }
  };
  const runWithCrossTabLease = async () => {
    const queueLearnerIds = normalizeLearnerIds(learnerIds);
    if (queueLearnerIds.length === 0 || typeof indexedDB === "undefined") return run();
    const leaseKey = getRecordingQueueLeaseKey(queueLearnerIds);
    const acquired = await acquireSyncLease(leaseKey);
    if (!acquired) return;
    const runWithRelease = async () => {
      const heartbeat = setInterval(
        () => {
          void renewSyncLease(leaseKey).catch(() => {
            // An expiring lease is safer than throwing from a timer. The next
            // foreground sync will recover uploading rows if this tab suspends.
          });
        },
        Math.floor(LEASE_MS / 3),
      );
      try {
        return await run();
      } finally {
        clearInterval(heartbeat);
        await releaseSyncLease(leaseKey);
      }
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return runWithRelease();
    return locks.request("kotoba-loop-recording-sync", { ifAvailable: true }, (lock) =>
      lock ? runWithRelease() : releaseSyncLease(leaseKey),
    );
  };
  syncInFlight = (async () => {
    do {
      syncTrailingPassRequested = false;
      await runWithCrossTabLease();
    } while (syncTrailingPassRequested);
  })().finally(() => {
    syncInFlight = null;
    syncTrailingPassRequested = false;
  });
  return syncInFlight;
}

export async function __resetRecordingQueueForTests() {
  listeners.clear();
  queueChannel?.close();
  queueChannel = null;
  syncOwnerId = null;
  syncInFlight = null;
  syncTrailingPassRequested = false;
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
