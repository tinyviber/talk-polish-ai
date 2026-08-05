import type {
  DurableWorkflowState,
  FeedbackState,
  QueueStatus,
  RecordingQueueItem,
} from "./recording-outbox/model";
import {
  isFeedbackOutstanding,
  isQueueSyncCandidate,
  recoverQueueStatus,
} from "./recording-outbox/transition-policy";
import {
  PROCESSING_POLL_DELAYS_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  backoffDelay,
} from "./recording-outbox/retry-policy";
import { shouldRetainForFeedback } from "./recording-outbox/retention-policy";

export type {
  DurableWorkflowState,
  FeedbackState,
  QueueStatus,
  RecordingQueueItem,
} from "./recording-outbox/model";
export {
  isFeedbackOutstanding,
  isQueueSyncCandidate,
  recoverQueueStatus,
} from "./recording-outbox/transition-policy";

const DB_NAME = "kotoba-loop-offline";
const STORE = "recordings";
const LEASE_STORE = "syncLeases";
const DB_VERSION = 6;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;
const LEASE_MS = 30_000;
const LEASE_MISS_RETRY_DELAY_MS = 1_500;
const LEASE_MISS_JITTER_MS = 750;
const QUEUE_CHANGE_STORAGE_KEY = "kotoba.queue.change.v1";
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase> | null = null;
let queueChannel: BroadcastChannel | null = null;
let syncOwnerId: string | null = null;
let syncTrailingPassRequested = false;
let storageListenerInstalled = false;

function ensureQueueChannel() {
  if (listeners.size === 0) return null;
  if (typeof window !== "undefined" && !storageListenerInstalled) {
    window.addEventListener("storage", onStorageChange);
    storageListenerInstalled = true;
  }
  if (typeof BroadcastChannel === "undefined") return null;
  queueChannel ??= new BroadcastChannel("kotoba-loop-recording-queue");
  queueChannel.onmessage ??= () => {
    listeners.forEach((listener) => listener());
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("kotoba:queue-change", { detail: { internal: false } }));
    }
  };
  return queueChannel;
}

function closeQueueChannelIfUnused() {
  if (listeners.size > 0) return;
  queueChannel?.close();
  queueChannel = null;
  if (typeof window !== "undefined" && storageListenerInstalled) {
    window.removeEventListener("storage", onStorageChange);
  }
  storageListenerInstalled = false;
}

function onStorageChange(event: StorageEvent) {
  if (event.key !== QUEUE_CHANGE_STORAGE_KEY) return;
  listeners.forEach((listener) => listener());
  window.dispatchEvent(new CustomEvent("kotoba:queue-change", { detail: { internal: false } }));
}

function broadcastChange() {
  if (listeners.size === 0) return;
  const channel = ensureQueueChannel();
  channel?.postMessage({ type: "queue-change" });
  try {
    if (!channel && typeof window !== "undefined") {
      window.localStorage.setItem(QUEUE_CHANGE_STORAGE_KEY, String(Date.now()));
    }
  } catch {
    // BroadcastChannel remains primary; storage may be disabled by policy.
  }
}

function notify(internal = false) {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("kotoba:queue-change", { detail: { internal } }));
  }
  broadcastChange();
}

export function orderRecordingQueue(items: RecordingQueueItem[]) {
  return [...items].sort(
    (a, b) => a.createdAt - b.createdAt || a.clientAttemptId.localeCompare(b.clientAttemptId),
  );
}

export function canSyncAttempt(
  item: RecordingQueueItem,
  items: RecordingQueueItem[],
  learnerIds?: string | string[],
) {
  if (item.attemptIndex === 1) return true;
  // Durable evidence captured only when attempt one was already consumed.
  if (item.prerequisiteSatisfied) return true;
  const allowedLearnerIds = normalizeLearnerIds(learnerIds ?? item.learnerId);
  return items.some(
    (candidate) =>
      learnerMatches(candidate, allowedLearnerIds) &&
      candidate.clientSessionId === item.clientSessionId &&
      candidate.attemptIndex === 1 &&
      candidate.syncStatus === "ready" &&
      (candidate.feedbackState === "delivered" || candidate.workflowState === "consumed"),
  );
}

function normalizeLearnerIds(learnerIds?: string | string[]) {
  return [...new Set(Array.isArray(learnerIds) ? learnerIds : learnerIds ? [learnerIds] : [])];
}

function getBackoffDelay(delays: readonly number[], index?: number) {
  return backoffDelay(delays, index);
}

function clearDeferredSyncState(item: RecordingQueueItem): RecordingQueueItem {
  return {
    ...item,
    nextPollAt: undefined,
    processingPollIndex: undefined,
    transientRetryIndex: undefined,
  };
}

function sessionDependencyKey(clientSessionId: string) {
  return clientSessionId;
}

/**
 * Normalize rows from older queue schemas without turning historical uploads
 * into new recovery work. Only rows that explicitly carried the v5 feedback
 * workflow are eligible for automatic feedback recovery.
 */
export function migrateRecordingQueueRecord(
  value: Record<string, unknown>,
  oldVersion: number,
): Record<string, unknown> {
  const legacy = !value["learnerId"];
  const ready = value["syncStatus"] === "ready";
  const feedbackState = value["feedbackState"];
  const isPreFeedbackWorkflowSchema = oldVersion < 5;
  const explicitFeedbackPending =
    ready && (feedbackState === "pending" || feedbackState === "error");
  const explicitAwaitingFeedback =
    ready &&
    !isPreFeedbackWorkflowSchema &&
    value["workflowState"] === "awaiting-feedback" &&
    (feedbackState === "pending" || feedbackState === "error");
  const legacyUnknownFeedback = explicitFeedbackPending && !explicitAwaitingFeedback;
  const clientSessionId =
    typeof value["clientSessionId"] === "string" && value["clientSessionId"]
      ? value["clientSessionId"]
      : typeof value["sessionId"] === "string" && value["sessionId"]
        ? `legacy-session:${value["sessionId"]}`
        : `legacy-attempt:${String(value["clientAttemptId"] ?? "unknown")}`;
  const workflowState = legacy
    ? "abandoned"
    : legacyUnknownFeedback
      ? "legacy-unknown"
      : explicitAwaitingFeedback
        ? "awaiting-feedback"
        : value["workflowState"] === "consumed"
          ? "consumed"
          : value["workflowState"] === "abandoned"
            ? "abandoned"
            : ready
              ? "consumed"
              : "awaiting-upload";

  return {
    ...value,
    clientSessionId,
    ...(legacy
      ? {
          learnerId: "legacy",
          syncStatus: "failed",
          lastError: "This recording needs to be re-recorded after the app update.",
        }
      : {}),
    ...(ready && !explicitFeedbackPending ? { feedbackState: "delivered" } : {}),
    workflowState,
    workflowUpdatedAt:
      typeof value["workflowUpdatedAt"] === "number"
        ? value["workflowUpdatedAt"]
        : typeof value["feedbackUpdatedAt"] === "number"
          ? value["feedbackUpdatedAt"]
          : value["createdAt"],
    revision: typeof value["revision"] === "number" ? value["revision"] : 0,
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
  return orderRecordingQueue(items).filter((item) => {
    if (!learnerMatches(item, queueLearnerIds) || !isQueueSyncCandidate(item.syncStatus))
      return false;
    // An interrupted upload must wake the scheduler even if its attempt-two
    // prerequisite is not currently visible; sync will recover it first.
    if (item.syncStatus === "uploading") return true;
    return canSyncAttempt(item, items, queueLearnerIds);
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
    request.onupgradeneeded = (event) => {
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
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
        cursor.update(migrateRecordingQueueRecord(value, oldVersion));
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

async function put(item: RecordingQueueItem, internal = false): Promise<RecordingQueueItem | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let wrote = false;
  let persisted: RecordingQueueItem | null = null;
  const request = store.get(item.clientAttemptId);
  request.onsuccess = () => {
    const current = request.result as RecordingQueueItem | undefined;
    // A late worker must never move a completed attempt back to an
    // in-flight/error state after another tab has finished it.
    if (current?.syncStatus === "ready") return;
    if (current?.workflowState === "abandoned" || current?.workflowState === "consumed") return;
    if (item.revision !== undefined && item.revision < (current?.revision ?? 0)) return;
    persisted = { ...item, revision: (current?.revision ?? 0) + 1 };
    store.put(persisted);
    wrote = true;
  };
  await waitForTransactionWrite(request, tx);
  if (wrote) notify(internal);
  return persisted;
}

async function remove(clientAttemptId: string, internal = false) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const request = tx.objectStore(STORE).delete(clientAttemptId);
  await waitForTransactionWrite(request, tx);
  notify(internal);
}

export async function cleanupRecordingQueue(
  now = Date.now(),
  protectedSessionKeys: ReadonlySet<string> = new Set(),
  internal = false,
) {
  const items = await allItems();
  const pendingSecondSessionKeys = new Set(
    items
      .filter((item) => item.attemptIndex === 2 && item.syncStatus !== "ready")
      .map((item) => sessionDependencyKey(item.clientSessionId)),
  );
  for (const key of protectedSessionKeys) pendingSecondSessionKeys.add(key);
  // Never silently delete a recording that still needs upload or processing,
  // nor one whose feedback has never been delivered to the learner.
  const expired = items.filter(
    (item) =>
      now - item.createdAt > TTL_MS &&
      (item.syncStatus === "ready" || item.syncStatus === "failed") &&
      !shouldRetainForFeedback(item, now) &&
      !(
        item.attemptIndex === 1 &&
        item.syncStatus === "ready" &&
        pendingSecondSessionKeys.has(sessionDependencyKey(item.clientSessionId))
      ),
  );

  for (const item of expired) await remove(item.clientAttemptId, internal);
}

/** Recover a tab that was suspended after marking an item uploading. */
export async function recoverInterruptedUploads(internal = false, learnerIds?: string | string[]) {
  const items = await allItems();
  const allowedLearnerIds = normalizeLearnerIds(learnerIds);
  for (const item of items.filter(
    (candidate) =>
      candidate.syncStatus === "uploading" &&
      (allowedLearnerIds.length === 0 || learnerMatches(candidate, allowedLearnerIds)),
  )) {
    await put(
      {
        ...clearDeferredSyncState(item),
        syncStatus: recoverQueueStatus(item.syncStatus),
        lastError: undefined,
      },
      internal,
    );
  }
}

export async function enqueueRecording(
  input: Omit<RecordingQueueItem, "syncStatus">,
  learnerIds?: string | string[],
) {
  if (!input.learnerId || input.learnerId === "legacy") {
    throw new Error("Learner session is unavailable; recording was not queued.");
  }
  const incomingPrerequisite =
    input.attemptIndex === 2
      ? new Set([sessionDependencyKey(input.clientSessionId)])
      : new Set<string>();
  await cleanupRecordingQueue(Date.now(), incomingPrerequisite);
  const existing = await allItems();
  const existingItem = existing.find((item) => item.clientAttemptId === input.clientAttemptId);
  if (
    existingItem &&
    (existingItem.syncStatus === "queued" ||
      existingItem.syncStatus === "uploading" ||
      existingItem.syncStatus === "processing" ||
      existingItem.syncStatus === "ready")
  ) {
    return input.clientAttemptId;
  }
  const allowedLearnerIds = normalizeLearnerIds(learnerIds ?? input.learnerId);
  // The server already holds a ready attempt for this slot whose feedback was
  // never delivered. Re-recording would orphan it and create a duplicate
  // attempt for the same (session, index); hand the caller that row instead.
  const outstanding = existing.find(
    (item) =>
      learnerMatches(item, allowedLearnerIds) &&
      item.clientSessionId === input.clientSessionId &&
      item.attemptIndex === input.attemptIndex &&
      item.clientAttemptId !== input.clientAttemptId &&
      isFeedbackOutstanding(item),
  );
  if (outstanding) return outstanding.clientAttemptId;

  // Synced recordings keep only metadata, so they never consume the quota.
  const totalBytes = existing
    .filter((item) => item.syncStatus !== "ready")
    .reduce((sum, item) => sum + item.blob.size, 0);
  if (totalBytes + input.blob.size > MAX_BYTES) {
    throw new Error("Offline recording storage is full. Retry or remove an older recording first.");
  }
  const prerequisiteSatisfied =
    input.attemptIndex === 2 &&
    (input.prerequisiteSatisfied === true ||
      existing.some(
        (item) =>
          learnerMatches(item, allowedLearnerIds) &&
          item.clientSessionId === input.clientSessionId &&
          item.attemptIndex === 1 &&
          item.syncStatus === "ready" &&
          (item.feedbackState === "delivered" || item.workflowState === "consumed"),
      ));
  await put({
    ...input,
    ...(input.attemptIndex === 2 ? { prerequisiteSatisfied } : {}),
    workflowState: "awaiting-upload",
    workflowUpdatedAt: Date.now(),
    syncStatus: "queued",
  });
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
    feedbackState: item.feedbackState === "delivered" ? "delivered" : "pending",
    feedbackUpdatedAt: Date.now(),
    workflowState: item.workflowState === "abandoned" ? "abandoned" : "awaiting-feedback",
    workflowUpdatedAt: Date.now(),
  });
}

/** Durably record that a feedback read failed, so any tab can retry it later. */
export async function markFeedbackError(clientAttemptId: string, message: string) {
  await updateFeedbackState(clientAttemptId, "error", message);
}

/** Durably record that feedback reached the learner; releases the slot. */
export async function markFeedbackDelivered(clientAttemptId: string) {
  await updateFeedbackState(clientAttemptId, "delivered");
}

async function updateFeedbackState(
  clientAttemptId: string,
  feedbackState: FeedbackState,
  feedbackLastError?: string,
) {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable; feedback delivery was not saved.");
  }
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const request = store.get(clientAttemptId);
  request.onsuccess = () => {
    const item = request.result as RecordingQueueItem | undefined;
    if (!item || item.feedbackState === "delivered" || item.workflowState === "abandoned") return;
    // Read and write happen in one IDB transaction. A late error cannot regress
    // a feedback row already consumed by another tab.
    store.put({
      ...item,
      feedbackState,
      feedbackLastError,
      feedbackUpdatedAt: Date.now(),
      workflowState: feedbackState === "delivered" ? "consumed" : "awaiting-feedback",
      workflowUpdatedAt: Date.now(),
      revision: (item.revision ?? 0) + 1,
    });
  };
  await waitForTransactionWrite(request, tx);
  notify();
}

export async function listDurablePracticeWorkflows(learnerIds?: string | string[]) {
  return (await listRecordingQueue(learnerIds))
    .filter(
      (item) =>
        item.workflowState === "awaiting-feedback" &&
        item.syncStatus === "ready" &&
        isFeedbackOutstanding(item),
    )
    .sort(
      (a, b) =>
        (b.workflowUpdatedAt ?? b.createdAt) - (a.workflowUpdatedAt ?? a.createdAt) ||
        a.clientAttemptId.localeCompare(b.clientAttemptId),
    );
}

/** In-flight or permanently failed rows retain their original recording slot. */
export async function listPendingPracticeWorkflows(learnerIds?: string | string[]) {
  return (await listRecordingQueue(learnerIds))
    .filter(
      (item) =>
        (item.syncStatus === "queued" ||
          item.syncStatus === "uploading" ||
          item.syncStatus === "processing" ||
          item.syncStatus === "failed") &&
        item.workflowState !== "abandoned" &&
        item.workflowState !== "consumed",
    )
    .sort(
      (a, b) =>
        (b.workflowUpdatedAt ?? b.createdAt) - (a.workflowUpdatedAt ?? a.createdAt) ||
        a.clientAttemptId.localeCompare(b.clientAttemptId),
    );
}

/** Historical pending feedback is opt-in, never an automatic page takeover. */
export async function listLegacyUnknownWorkflows(learnerIds?: string | string[]) {
  return (await listRecordingQueue(learnerIds)).filter(
    (item) =>
      item.workflowState === "legacy-unknown" &&
      item.syncStatus === "ready" &&
      typeof item.attemptId === "string" &&
      item.attemptId.length > 0,
  );
}

/** User explicitly chose to inspect one migrated historical row. */
export async function adoptLegacyWorkflow(clientAttemptId: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const request = store.get(clientAttemptId);
  request.onsuccess = () => {
    const item = request.result as RecordingQueueItem | undefined;
    if (!item || item.workflowState !== "legacy-unknown" || item.syncStatus !== "ready") return;
    store.put({
      ...item,
      workflowState: "awaiting-feedback",
      feedbackState: item.feedbackState === "error" ? "error" : "pending",
      workflowUpdatedAt: Date.now(),
      revision: (item.revision ?? 0) + 1,
    });
  };
  await waitForTransactionWrite(request, tx);
  notify();
}

/** Explicit user action only. Recovery targets are never cleared implicitly. */
export async function abandonPracticeWorkflow(clientAttemptId: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const request = store.get(clientAttemptId);
  request.onsuccess = () => {
    const item = request.result as RecordingQueueItem | undefined;
    if (!item || item.workflowState === "consumed") return;
    store.put({
      ...item,
      workflowState: "abandoned",
      workflowUpdatedAt: Date.now(),
      revision: (item.revision ?? 0) + 1,
      feedbackLastError: undefined,
      ...(item.syncStatus === "ready"
        ? { blob: new Blob([], { type: item.mimeType }), blobDiscarded: true }
        : {}),
    });
  };
  await waitForTransactionWrite(request, tx);
  notify();
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
    closeQueueChannelIfUnused();
  };
}

export async function retryQueuedRecordings(learnerIds?: string | string[]) {
  if (!learnerIds || (Array.isArray(learnerIds) && learnerIds.length === 0)) return;
  const items = (await allItems()).filter((item) => learnerMatches(item, learnerIds));
  await Promise.all(
    items
      .filter(
        (item) =>
          item.syncStatus === "failed" ||
          item.syncStatus === "queued" ||
          item.syncStatus === "uploading" ||
          item.syncStatus === "processing",
      )
      .map((item) =>
        put({
          ...clearDeferredSyncState(item),
          syncStatus: item.syncStatus === "processing" ? "processing" : "queued",
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

export type SyncResult = { acquired: true } | { acquired: false; retryAt: number };

let syncInFlight: Promise<SyncResult> | null = null;

function getSyncOwnerId() {
  syncOwnerId ??=
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `sync-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return syncOwnerId;
}

function getLeaseMissRetryAt(now = Date.now()) {
  return now + LEASE_MISS_RETRY_DELAY_MS + Math.floor(Math.random() * LEASE_MISS_JITTER_MS);
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
  // Maintenance must run even when no upload is scheduled; otherwise a
  // migrated legacy-unknown row with no pending Blob can live forever.
  await cleanupRecordingQueue(now, new Set(), true);
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
    await recoverInterruptedUploads(true, queueLearnerIds);
    await cleanupRecordingQueue(Date.now(), new Set(), true);
    const queueItems = orderRecordingQueue(await allItems());
    const items = queueItems.filter(
      (item) => learnerMatches(item, queueLearnerIds) && isQueueSyncCandidate(item.syncStatus),
    );
    const now = Date.now();
    for (const item of items) {
      if (item.nextPollAt !== undefined && item.nextPollAt > now) continue;
      if (item.attemptIndex === 2 && !canSyncAttempt(item, queueItems, queueLearnerIds)) continue;
      let syncing: RecordingQueueItem | null = null;
      try {
        const candidate =
          item.syncStatus === "processing"
            ? item
            : ({
                ...clearDeferredSyncState(item),
                syncStatus: "uploading",
                lastError: undefined,
              } as RecordingQueueItem);
        syncing = await put(candidate, true);
        if (!syncing) continue;
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
                  ? {
                      blob: new Blob([], { type: syncing.mimeType }),
                      blobDiscarded: true,
                      workflowState: (syncing.workflowState === "abandoned"
                        ? "abandoned"
                        : "awaiting-feedback") as DurableWorkflowState,
                      workflowUpdatedAt: Date.now(),
                    }
                  : {
                      workflowState: (syncing.workflowState === "abandoned"
                        ? "abandoned"
                        : "awaiting-upload") as DurableWorkflowState,
                      workflowUpdatedAt: Date.now(),
                    }),
              };
        await put({ ...nextItem }, true);
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
        const current = syncing ?? item;
        await put(
          isTransientUploadError(error)
            ? scheduleTransientRetry(
                current.syncStatus === "processing"
                  ? current
                  : ({
                      ...clearDeferredSyncState(current),
                      syncStatus: "uploading",
                      lastError: undefined,
                    } as RecordingQueueItem),
                message,
              )
            : {
                ...clearDeferredSyncState(current),
                syncStatus: "failed",
                lastError: message,
              },
          true,
        );
        if (isTransientUploadError(error)) break;
      }
    }
  };
  const runWithCrossTabLease = async (): Promise<SyncResult> => {
    const queueLearnerIds = normalizeLearnerIds(learnerIds);
    if (queueLearnerIds.length === 0 || typeof indexedDB === "undefined") {
      await run();
      return { acquired: true };
    }
    const leaseKey = getRecordingQueueLeaseKey(queueLearnerIds);
    const acquired = await acquireSyncLease(leaseKey);
    if (!acquired) return { acquired: false, retryAt: getLeaseMissRetryAt() };
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
        await run();
        return { acquired: true } as const;
      } finally {
        clearInterval(heartbeat);
        await releaseSyncLease(leaseKey);
      }
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return runWithRelease();
    return locks.request("kotoba-loop-recording-sync", { ifAvailable: true }, (lock) =>
      lock
        ? runWithRelease()
        : releaseSyncLease(leaseKey).then(() => ({
            acquired: false,
            retryAt: getLeaseMissRetryAt(),
          })),
    );
  };
  syncInFlight = (async () => {
    let result: SyncResult = { acquired: true };
    do {
      syncTrailingPassRequested = false;
      result = await runWithCrossTabLease();
    } while (syncTrailingPassRequested && result.acquired);
    return result;
  })().finally(() => {
    syncInFlight = null;
    syncTrailingPassRequested = false;
  });
  return syncInFlight;
}

export async function __resetRecordingQueueForTests() {
  listeners.clear();
  closeQueueChannelIfUnused();
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
