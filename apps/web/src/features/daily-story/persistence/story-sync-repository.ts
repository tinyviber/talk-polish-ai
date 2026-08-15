import {
  dailyStorySyncConversationSchema,
  type DailyStorySyncConversation,
} from "@kotoba/contracts";
import { createId, type DailyReview, type StorySession } from "../types";
import {
  CURRENT,
  SYNC_CONFIG_STORE,
  SYNC_CONFLICT_STORE,
  SYNC_META_STORE,
  SYNC_OUTBOX_STORE,
} from "./internal/database";
import {
  syncConfigSchema,
  syncConflictSchema,
  syncMetaSchema,
  syncOutboxSchema,
  type StoredSyncConflict,
  type StoredSyncMeta,
  type StoredSyncOutbox,
} from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";
import { readStorySession } from "./story-session-repository";

export type SyncOperation = "upsert" | "delete";

/** Durable mutation enqueue used by session CAS transactions. */
export function queueStorySyncInTransaction(
  tx: IDBTransaction,
  conversationId: string,
  operation: SyncOperation,
  session: StorySession | null,
  onComplete: () => void,
) {
  if (isStorySyncSuppressed()) {
    onComplete();
    return;
  }
  const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
  const metaRequest = tx.objectStore(SYNC_META_STORE).get(conversationId);
  const existingRequest = outbox.get(conversationId);
  let meta: StoredSyncMeta | null = null;
  let existing: StoredSyncOutbox | null = null;
  let metaReady = false;
  let existingReady = false;
  const commit = () => {
    if (!metaReady || !existingReady) return;
    const payload =
      operation === "upsert" && session ? toSyncConversation(session, conversationId) : null;
    const record = syncOutboxSchema.parse({
      conversationId,
      operation,
      mutationId: createId("sync"),
      expectedRemoteRevision: existing?.expectedRemoteRevision ?? meta?.remoteRevision ?? null,
      localRevision: payload?.revision ?? null,
      payload,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
    });
    const write = outbox.put(record);
    write.onsuccess = onComplete;
  };
  metaRequest.onsuccess = () => {
    meta = metaRequest.result === undefined ? null : syncMetaSchema.parse(metaRequest.result);
    metaReady = true;
    commit();
  };
  existingRequest.onsuccess = () => {
    existing =
      existingRequest.result === undefined ? null : syncOutboxSchema.parse(existingRequest.result);
    existingReady = true;
    commit();
  };
}

let syncSuppressionDepth = 0;

export function isStorySyncSuppressed() {
  return syncSuppressionDepth > 0;
}

export async function withoutStorySync<T>(run: () => Promise<T>) {
  syncSuppressionDepth += 1;
  try {
    return await run();
  } finally {
    syncSuppressionDepth -= 1;
  }
}

export function toSyncConversation(
  session: StorySession,
  conversationId: string,
): DailyStorySyncConversation {
  return dailyStorySyncConversationSchema.parse({
    conversationId,
    schemaVersion: 1,
    revision: session.revision,
    ...(session.sessionInstanceId ? { sessionInstanceId: session.sessionInstanceId } : {}),
    updatedAt: session.updatedAt,
    phase: session.phase,
    storyZh: session.storyZh,
    ...(session.title ? { title: session.title } : {}),
    messages: session.messages,
    ...(session.pendingAsrTranscript ? { pendingAsrTranscript: session.pendingAsrTranscript } : {}),
    ...(session.review ? { review: session.review } : {}),
  });
}

export function fromSyncConversation(value: DailyStorySyncConversation): StorySession {
  return {
    schemaVersion: 1,
    revision: value.revision,
    ...(value.sessionInstanceId ? { sessionInstanceId: value.sessionInstanceId } : {}),
    updatedAt: value.updatedAt,
    phase: value.phase,
    storyZh: value.storyZh,
    ...(value.title ? { title: value.title } : {}),
    messages: value.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.source ? { source: message.source } : {}),
      ...(message.rawText ? { rawText: message.rawText } : {}),
    })),
    ...(value.pendingAsrTranscript
      ? {
          pendingAsrTranscript: {
            id: value.pendingAsrTranscript.id,
            text: value.pendingAsrTranscript.text,
            ...(value.pendingAsrTranscript.rawText
              ? { rawText: value.pendingAsrTranscript.rawText }
              : {}),
          },
        }
      : {}),
    ...(value.review ? { review: value.review as DailyReview } : {}),
  };
}

export async function readSyncToken() {
  return transaction<string | null>(SYNC_CONFIG_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_CONFIG_STORE).get(CURRENT);
    request.onsuccess = () => {
      const record = request.result as unknown;
      if (record === undefined) {
        setResult(tx, null);
        return;
      }
      setResult(tx, syncConfigSchema.parse(record).token);
    };
  });
}

export async function writeSyncToken(token: string | null) {
  const normalized = token?.trim() ?? "";
  await transaction<void>(SYNC_CONFIG_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_CONFIG_STORE);
    if (!normalized) {
      const request = store.delete(CURRENT);
      request.onsuccess = () => setResult(tx, undefined);
      return;
    }
    const request = store.put(
      syncConfigSchema.parse({
        id: CURRENT,
        schemaVersion: 1,
        token: normalized,
        updatedAt: new Date().toISOString(),
      }),
    );
    request.onsuccess = () => setResult(tx, undefined);
  });
}

export async function readSyncMeta(conversationId: string): Promise<StoredSyncMeta | null> {
  return transaction<StoredSyncMeta | null>(SYNC_META_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_META_STORE).get(conversationId);
    request.onsuccess = () => {
      const value = request.result as unknown;
      setResult(tx, value === undefined ? null : syncMetaSchema.parse(value));
    };
  });
}

export async function listSyncOutbox(): Promise<StoredSyncOutbox[]> {
  return transaction<StoredSyncOutbox[]>(SYNC_OUTBOX_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_OUTBOX_STORE).getAll();
    request.onsuccess = () =>
      setResult(
        tx,
        (request.result as unknown[]).map((value) => syncOutboxSchema.parse(value)),
      );
  });
}

export async function listSyncConflicts(): Promise<StoredSyncConflict[]> {
  return transaction<StoredSyncConflict[]>(SYNC_CONFLICT_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_CONFLICT_STORE).getAll();
    request.onsuccess = () =>
      setResult(
        tx,
        (request.result as unknown[]).map((value) => syncConflictSchema.parse(value)),
      );
  });
}

export async function queueStorySync(conversationId: string, operation?: SyncOperation) {
  const session = await readStorySession(conversationId);
  const resolvedOperation = operation ?? (session ? "upsert" : "delete");
  const payload =
    resolvedOperation === "upsert" && session ? toSyncConversation(session, conversationId) : null;
  await transaction<void>([SYNC_OUTBOX_STORE, SYNC_META_STORE], "readwrite", (tx) => {
    const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
    const meta = tx.objectStore(SYNC_META_STORE).get(conversationId);
    const existing = outbox.get(conversationId);
    let metaValue: StoredSyncMeta | null = null;
    let existingValue: StoredSyncOutbox | null = null;
    let metaReady = false;
    let existingReady = false;
    const commit = () => {
      if (!metaReady || !existingReady) return;
      const expectedRemoteRevision =
        existingValue?.expectedRemoteRevision ?? metaValue?.remoteRevision ?? null;
      const record = syncOutboxSchema.parse({
        conversationId,
        operation: resolvedOperation,
        mutationId: createId("sync"),
        expectedRemoteRevision,
        localRevision: payload?.revision ?? null,
        payload,
        queuedAt: new Date().toISOString(),
        attempts: 0,
        nextAttemptAt: 0,
      });
      const write = outbox.put(record);
      write.onsuccess = () => setResult(tx, undefined);
    };
    meta.onsuccess = () => {
      metaValue = meta.result === undefined ? null : syncMetaSchema.parse(meta.result);
      metaReady = true;
      commit();
    };
    existing.onsuccess = () => {
      existingValue =
        existing.result === undefined ? null : syncOutboxSchema.parse(existing.result);
      existingReady = true;
      commit();
    };
  });
}

export async function markSyncAttempt(
  item: StoredSyncOutbox,
  error: string,
  nextAttemptAt: number,
) {
  await transaction<void>(SYNC_OUTBOX_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_OUTBOX_STORE);
    const current = store.get(item.conversationId);
    current.onsuccess = () => {
      const value = current.result === undefined ? null : syncOutboxSchema.parse(current.result);
      if (!value || value.mutationId !== item.mutationId) {
        setResult(tx, undefined);
        return;
      }
      const write = store.put({
        ...value,
        attempts: value.attempts + 1,
        nextAttemptAt,
        lastError: error.slice(0, 600),
      });
      write.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export async function rebaseSyncOutbox(
  item: StoredSyncOutbox,
  expectedRemoteRevision: number | null,
  payload: DailyStorySyncConversation | null,
) {
  await transaction<void>(SYNC_OUTBOX_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_OUTBOX_STORE);
    const current = store.get(item.conversationId);
    current.onsuccess = () => {
      const value = current.result === undefined ? null : syncOutboxSchema.parse(current.result);
      if (!value || value.mutationId !== item.mutationId) {
        setResult(tx, undefined);
        return;
      }
      const write = store.put(
        syncOutboxSchema.parse({
          ...value,
          mutationId: createId("sync"),
          expectedRemoteRevision,
          payload,
          localRevision: payload?.revision ?? null,
          attempts: 0,
          nextAttemptAt: 0,
          queuedAt: new Date().toISOString(),
          lastError: undefined,
        }),
      );
      write.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export async function dropSyncOutbox(conversationId: string, mutationId?: string) {
  await transaction<void>(SYNC_OUTBOX_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_OUTBOX_STORE);
    if (!mutationId) {
      const request = store.delete(conversationId);
      request.onsuccess = () => setResult(tx, undefined);
      return;
    }
    const current = store.get(conversationId);
    current.onsuccess = () => {
      const value = current.result === undefined ? null : syncOutboxSchema.parse(current.result);
      if (!value || value.mutationId !== mutationId) {
        setResult(tx, undefined);
        return;
      }
      const request = store.delete(conversationId);
      request.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export async function markSyncSuccess(
  item: StoredSyncOutbox,
  remoteRevision: number,
  localRevision: number | null,
) {
  await transaction<void>([SYNC_META_STORE, SYNC_OUTBOX_STORE], "readwrite", (tx) => {
    const metas = tx.objectStore(SYNC_META_STORE);
    const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
    const current = outbox.get(item.conversationId);
    current.onsuccess = () => {
      const currentValue =
        current.result === undefined ? null : syncOutboxSchema.parse(current.result);
      const meta = syncMetaSchema.parse({
        conversationId: item.conversationId,
        remoteRevision,
        localRevision,
        ...(item.payload?.sessionInstanceId
          ? { sessionInstanceId: item.payload.sessionInstanceId }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      const writeMeta = metas.put(meta);
      writeMeta.onsuccess = () => {
        if (currentValue?.mutationId !== item.mutationId) {
          setResult(tx, undefined);
          return;
        }
        const remove = outbox.delete(item.conversationId);
        remove.onsuccess = () => setResult(tx, undefined);
      };
    };
  });
}

export async function markRemoteRevision(
  conversationId: string,
  remoteRevision: number,
  localRevision: number | null,
  sessionInstanceId?: string,
) {
  await transaction<void>(SYNC_META_STORE, "readwrite", (tx) => {
    const record = syncMetaSchema.parse({
      conversationId,
      remoteRevision,
      localRevision,
      ...(sessionInstanceId ? { sessionInstanceId } : {}),
      updatedAt: new Date().toISOString(),
    });
    const request = tx.objectStore(SYNC_META_STORE).put(record);
    request.onsuccess = () => setResult(tx, undefined);
  });
}

export async function readConflict(conflictKey: string): Promise<StoredSyncConflict | null> {
  return transaction<StoredSyncConflict | null>(SYNC_CONFLICT_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_CONFLICT_STORE).get(conflictKey);
    request.onsuccess = () => {
      const value = request.result as unknown;
      setResult(tx, value === undefined ? null : syncConflictSchema.parse(value));
    };
  });
}

export async function recordConflict(
  conflictKey: string,
  sourceConversationId: string,
  conflictConversationId: string | undefined,
  operation: SyncOperation = "upsert",
) {
  await transaction<void>(SYNC_CONFLICT_STORE, "readwrite", (tx) => {
    const request = tx.objectStore(SYNC_CONFLICT_STORE).put(
      syncConflictSchema.parse({
        conflictKey,
        sourceConversationId,
        operation,
        ...(conflictConversationId ? { conflictConversationId } : {}),
        createdAt: new Date().toISOString(),
      }),
    );
    request.onsuccess = () => setResult(tx, undefined);
  });
}

export function conflictConversationId(sourceConversationId: string, mutationId: string) {
  const source = sourceConversationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 92);
  const mutation = mutationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(-48);
  return `conflict_${source}_${mutation}`.slice(0, 159);
}

export function conflictKey(sourceConversationId: string, mutationId: string) {
  return `conflict:${sourceConversationId}:${mutationId}`;
}
