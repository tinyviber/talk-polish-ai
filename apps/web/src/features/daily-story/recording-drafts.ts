import type { DailyStoryAudioPurpose } from "./audio-outbox";

export const MAX_RECORDING_DRAFT_SEGMENTS = 10;
export const MAX_RECORDING_DRAFT_BYTES = 25 * 1024 * 1024;

const DB_NAME = "kotoba-daily-story-recording-drafts";
const DB_VERSION = 1;
const DRAFT_STORE = "recordingDrafts";
const SEGMENT_STORE = "recordingSegments";

export type RecordingDraftSegment = {
  id: string;
  draftId: string;
  sequence: number;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: number;
};

export type RecordingDraft = {
  id: string;
  conversationId: string;
  purpose: DailyStoryAudioPurpose;
  readAloudTarget?: string;
  segments: RecordingDraftSegment[];
  totalDurationSec: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
  status: "draft" | "failed" | "submitting" | "completed";
  clientAttemptId?: string;
  transcript?: string;
  transcriptId?: string;
  cleanupError?: string;
  error?: string;
  failureKind?: RecordingDraftFailureKind;
};

export type RecordingDraftMap = Record<DailyStoryAudioPurpose, RecordingDraft | null>;
export type RecordingDraftFailureKind = "known" | "unknown";

type DraftRecord = Omit<RecordingDraft, "segments"> & { segmentIds: string[] };

let databasePromise: Promise<IDBDatabase> | undefined;

type TransactionState = { result?: unknown; failure?: unknown };
const transactionStates = new WeakMap<IDBTransaction, TransactionState>();

const RECOVERABLE_DATABASE_ERRORS = new Set([
  "AbortError",
  "InvalidStateError",
  "TransactionInactiveError",
  "TransactionClosedError",
  "DatabaseClosedError",
]);

function isRecoverableDatabaseError(error: unknown) {
  return error instanceof DOMException
    ? RECOVERABLE_DATABASE_ERRORS.has(error.name)
    : Boolean(
        error &&
        typeof error === "object" &&
        "name" in error &&
        RECOVERABLE_DATABASE_ERRORS.has(String((error as { name?: unknown }).name)),
      );
}

function resetCachedConnection(db?: IDBDatabase) {
  const cached = databasePromise;
  databasePromise = undefined;
  void cached
    ?.then((current) => {
      if (!db || current === db) current.close();
    })
    .catch(() => {});
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  if (databasePromise) return databasePromise;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE))
        db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SEGMENT_STORE)) {
        db.createObjectStore(SEGMENT_STORE, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open recording drafts"));
    request.onblocked = () => reject(new Error("Recording draft database upgrade is blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        resetCachedConnection(db);
      };
      db.onclose = () => {
        if (databasePromise === promise) databasePromise = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    if (databasePromise === promise) databasePromise = undefined;
    throw error;
  });
  databasePromise = promise;
  return promise;
}

function draftId(conversationId: string, purpose: DailyStoryAudioPurpose) {
  return `${conversationId}:${purpose}`;
}

function isDraftForConversation(record: DraftRecord, conversationId: string) {
  return record.conversationId === conversationId;
}

function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => void,
) {
  const attempt = (canRecover: boolean): Promise<T> =>
    openDatabase()
      .then(
        (db) =>
          new Promise<T>((resolve, reject) => {
            const state: TransactionState = {};
            let tx: IDBTransaction;
            try {
              tx = db.transaction(stores, mode);
            } catch (error) {
              reject(error);
              return;
            }
            transactionStates.set(tx, state);
            tx.oncomplete = () =>
              state.failure ? reject(state.failure) : resolve(state.result as T);
            tx.onerror = () =>
              reject(state.failure ?? tx.error ?? new Error("Recording draft transaction failed"));
            tx.onabort = () =>
              reject(state.failure ?? tx.error ?? new Error("Recording draft transaction aborted"));
            try {
              run(tx);
            } catch (error) {
              setFailure(tx, error);
            }
          }),
      )
      .catch((error: unknown) => {
        if (!canRecover || !isRecoverableDatabaseError(error)) throw error;
        resetCachedConnection();
        return attempt(false);
      });
  return attempt(true);
}

function setResult<T>(tx: IDBTransaction, value: T) {
  const state = transactionStates.get(tx);
  if (state) state.result = value;
}

function setFailure(tx: IDBTransaction, error: unknown) {
  const state = transactionStates.get(tx);
  if (state) state.failure = error;
  try {
    tx.abort();
  } catch {
    // The transaction may already be aborted by the browser.
  }
}

function hydrate(record: DraftRecord, segments: RecordingDraftSegment[]): RecordingDraft {
  return { ...record, segments };
}

function stripTransientDraftFields(record: DraftRecord) {
  const {
    clientAttemptId: _clientAttemptId,
    transcript: _transcript,
    transcriptId: _transcriptId,
    cleanupError: _cleanupError,
    error: _error,
    failureKind: _failureKind,
    ...stable
  } = record;
  return stable;
}

export async function getRecordingDraft(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
): Promise<RecordingDraft | null> {
  const id = draftId(conversationId, purpose);
  const record = await transaction<DraftRecord | undefined>([DRAFT_STORE], "readonly", (tx) => {
    const request = tx.objectStore(DRAFT_STORE).get(id);
    request.onsuccess = () => setResult(tx, request.result as DraftRecord | undefined);
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording draft"));
  });
  if (!record) return null;
  const segments = await transaction<RecordingDraftSegment[]>([SEGMENT_STORE], "readonly", (tx) => {
    const request = tx.objectStore(SEGMENT_STORE).getAll();
    request.onsuccess = () =>
      setResult(
        tx,
        (request.result as RecordingDraftSegment[])
          .filter((segment) => segment.draftId === id)
          .sort((a, b) => a.sequence - b.sequence),
      );
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording segments"));
  });
  return hydrate(record, segments);
}

export async function getRecordingDrafts(conversationId: string): Promise<RecordingDraftMap> {
  const records = await transaction<DraftRecord[]>([DRAFT_STORE], "readonly", (tx) => {
    const request = tx.objectStore(DRAFT_STORE).getAll();
    request.onsuccess = () =>
      setResult(
        tx,
        (request.result as DraftRecord[]).filter((record) =>
          isDraftForConversation(record, conversationId),
        ),
      );
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording drafts"));
  });
  if (records.length === 0) return { conversation: null, readAloud: null };
  const segments = await transaction<RecordingDraftSegment[]>([SEGMENT_STORE], "readonly", (tx) => {
    const request = tx.objectStore(SEGMENT_STORE).getAll();
    request.onsuccess = () => setResult(tx, request.result as RecordingDraftSegment[]);
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording segments"));
  });
  const grouped = new Map<string, RecordingDraftSegment[]>();
  for (const segment of segments) {
    const draftSegments = grouped.get(segment.draftId) ?? [];
    draftSegments.push(segment);
    grouped.set(segment.draftId, draftSegments);
  }
  const result: RecordingDraftMap = { conversation: null, readAloud: null };
  for (const record of records) {
    result[record.purpose] = hydrate(
      record,
      (grouped.get(record.id) ?? []).sort((a, b) => a.sequence - b.sequence),
    );
  }
  return result;
}

export async function appendRecordingDraftSegment(input: {
  conversationId: string;
  purpose: DailyStoryAudioPurpose;
  readAloudTarget?: string;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  segmentId: string;
}): Promise<RecordingDraft> {
  if (input.blob.size === 0) throw new Error("空录音不能加入草稿。");
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0)
    throw new Error("录音时长无效。");
  const id = draftId(input.conversationId, input.purpose);
  return transaction<RecordingDraft>([DRAFT_STORE, SEGMENT_STORE], "readwrite", (tx) => {
    const request = tx.objectStore(DRAFT_STORE).get(id);
    request.onsuccess = () => {
      try {
        const current = request.result as DraftRecord | undefined;
        const existing = current ?? {
          id,
          conversationId: input.conversationId,
          purpose: input.purpose,
          ...(input.readAloudTarget ? { readAloudTarget: input.readAloudTarget } : {}),
          segmentIds: [],
          totalDurationSec: 0,
          totalBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "draft" as const,
        };
        if (
          existing.purpose !== input.purpose ||
          existing.conversationId !== input.conversationId
        ) {
          setFailure(tx, new Error("录音草稿归属不匹配。"));
          return;
        }
        if (existing.segmentIds.length >= MAX_RECORDING_DRAFT_SEGMENTS) {
          setFailure(tx, new Error(`最多支持 ${MAX_RECORDING_DRAFT_SEGMENTS} 段续录。`));
          return;
        }
        if (existing.totalBytes + input.blob.size > MAX_RECORDING_DRAFT_BYTES) {
          setFailure(tx, new Error("录音草稿超过 25 MiB 限制，请完成转写或清空后重录。"));
          return;
        }
        const segment: RecordingDraftSegment = {
          id: input.segmentId,
          draftId: id,
          sequence: existing.segmentIds.length,
          blob: input.blob,
          mimeType: input.mimeType,
          durationSec: input.durationSec,
          createdAt: Date.now(),
        };
        const next: DraftRecord = {
          ...stripTransientDraftFields(existing),
          ...(input.readAloudTarget ? { readAloudTarget: input.readAloudTarget } : {}),
          segmentIds: [...existing.segmentIds, segment.id],
          totalDurationSec: existing.totalDurationSec + input.durationSec,
          totalBytes: existing.totalBytes + input.blob.size,
          updatedAt: Date.now(),
          status: "draft",
        };
        tx.objectStore(SEGMENT_STORE).put(segment);
        tx.objectStore(DRAFT_STORE).put(next);
        setResult(tx, hydrate(next, [segment]));
      } catch (error) {
        setFailure(tx, error);
      }
    };
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording draft"));
  }).then(async () => (await getRecordingDraft(input.conversationId, input.purpose))!);
}

export async function markRecordingDraftFailed(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
  error: string,
  failureKind: RecordingDraftFailureKind = "known",
) {
  const id = draftId(conversationId, purpose);
  return transaction<RecordingDraft | null>([DRAFT_STORE, SEGMENT_STORE], "readwrite", (tx) => {
    const request = tx.objectStore(DRAFT_STORE).get(id);
    request.onsuccess = () => {
      try {
        const record = request.result as DraftRecord | undefined;
        if (!record) return setResult(tx, null);
        const segmentRequest = tx.objectStore(SEGMENT_STORE).getAll();
        segmentRequest.onsuccess = () => {
          const segments = (segmentRequest.result as RecordingDraftSegment[])
            .filter((segment) => segment.draftId === id)
            .sort((a, b) => a.sequence - b.sequence);
          const next = {
            ...record,
            status: "failed" as const,
            error,
            failureKind,
            updatedAt: Date.now(),
          };
          tx.objectStore(DRAFT_STORE).put(next);
          setResult(tx, hydrate(next, segments));
        };
        segmentRequest.onerror = () =>
          setFailure(tx, segmentRequest.error ?? new Error("Unable to read recording segments"));
      } catch (failure) {
        setFailure(tx, failure);
      }
    };
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording draft"));
  });
}

async function updateDraftRecord(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
  update: (record: DraftRecord) => DraftRecord,
) {
  const id = draftId(conversationId, purpose);
  return transaction<RecordingDraft | null>([DRAFT_STORE, SEGMENT_STORE], "readwrite", (tx) => {
    const request = tx.objectStore(DRAFT_STORE).get(id);
    request.onsuccess = () => {
      try {
        const record = request.result as DraftRecord | undefined;
        if (!record) {
          setResult(tx, null);
          return;
        }
        const segmentRequest = tx.objectStore(SEGMENT_STORE).getAll();
        segmentRequest.onsuccess = () => {
          try {
            const segments = (segmentRequest.result as RecordingDraftSegment[])
              .filter((segment) => segment.draftId === id)
              .sort((a, b) => a.sequence - b.sequence);
            const next = update(record);
            tx.objectStore(DRAFT_STORE).put(next);
            setResult(tx, hydrate(next, segments));
          } catch (error) {
            setFailure(tx, error);
          }
        };
        segmentRequest.onerror = () =>
          setFailure(tx, segmentRequest.error ?? new Error("Unable to read recording segments"));
      } catch (error) {
        setFailure(tx, error);
      }
    };
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording draft"));
  });
}

export function markRecordingDraftSubmitting(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
  clientAttemptId: string,
) {
  return updateDraftRecord(conversationId, purpose, (record) => {
    if (record.status === "completed" || record.status === "submitting") return record;
    return {
      ...stripTransientDraftFields(record),
      status: "submitting",
      clientAttemptId,
      updatedAt: Date.now(),
    };
  });
}

export function markRecordingDraftCompleted(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
  input: { clientAttemptId: string; transcript: string; transcriptId: string },
) {
  return updateDraftRecord(conversationId, purpose, (record) => ({
    ...stripTransientDraftFields(record),
    status: "completed",
    clientAttemptId: input.clientAttemptId,
    transcript: input.transcript,
    transcriptId: input.transcriptId,
    updatedAt: Date.now(),
  }));
}

export function markRecordingDraftCleanupFailed(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
  error: string,
) {
  return updateDraftRecord(conversationId, purpose, (record) => ({
    ...record,
    status: record.status === "completed" ? "completed" : record.status,
    cleanupError: error,
    updatedAt: Date.now(),
  }));
}

export async function removeRecordingDraft(
  conversationId: string,
  purpose: DailyStoryAudioPurpose,
) {
  const id = draftId(conversationId, purpose);
  return transaction<boolean>([DRAFT_STORE, SEGMENT_STORE], "readwrite", (tx) => {
    const request = tx.objectStore(SEGMENT_STORE).getAll();
    request.onsuccess = () => {
      try {
        const segments = (request.result as RecordingDraftSegment[]).filter(
          (segment) => segment.draftId === id,
        );
        for (const segment of segments) tx.objectStore(SEGMENT_STORE).delete(segment.id);
        tx.objectStore(DRAFT_STORE).delete(id);
        setResult(tx, true);
      } catch (error) {
        setFailure(tx, error);
      }
    };
    request.onerror = () =>
      setFailure(tx, request.error ?? new Error("Unable to read recording segments"));
  });
}

export async function __resetRecordingDraftsForTests() {
  const db = await databasePromise?.catch(() => undefined);
  db?.close();
  databasePromise = undefined;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}
