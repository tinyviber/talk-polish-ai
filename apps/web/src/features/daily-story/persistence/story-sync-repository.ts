import {
  dailyStorySyncConversationSchema,
  type DailyStorySyncConversation,
} from "@kotoba/contracts";
import { createId, type DailyReview, type StorySession } from "../types";
import {
  CURRENT,
  SESSION_STORE,
  SYNC_CONFIG_STORE,
  SYNC_CONFLICT_STORE,
  SYNC_META_STORE,
  SYNC_OUTBOX_STORE,
} from "./internal/database";
import { fromStoredSession, sessionRecord } from "./internal/codecs";
import {
  sessionSchema,
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

export async function listSyncMeta(): Promise<StoredSyncMeta[]> {
  return transaction<StoredSyncMeta[]>(SYNC_META_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SYNC_META_STORE).getAll();
    request.onsuccess = () =>
      setResult(
        tx,
        (request.result as unknown[]).map((value) => syncMetaSchema.parse(value)),
      );
  });
}

/**
 * Reconciles legacy/imported sessions without a read-then-write race. The
 * decision and outbox insert share the primary IDB transaction. Sidecar
 * hydration happens only after the durable queue entry exists.
 */
export async function reconcileStorySyncOutbox() {
  const queued = await transaction<Array<{ conversationId: string; mutationId: string }>>(
    [SESSION_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE],
    "readwrite",
    (tx) => {
      const sessionsRequest = tx.objectStore(SESSION_STORE).getAll();
      const metasRequest = tx.objectStore(SYNC_META_STORE).getAll();
      const outboxRequest = tx.objectStore(SYNC_OUTBOX_STORE).getAll();
      let sessions: unknown[] | undefined;
      let metas: StoredSyncMeta[] | undefined;
      let outbox: StoredSyncOutbox[] | undefined;
      const finish = () => {
        if (!sessions || !metas || !outbox) return;
        const metaById = new Map(metas.map((value) => [value.conversationId, value]));
        const outboxById = new Map(outbox.map((value) => [value.conversationId, value]));
        const queuedItems: Array<{ conversationId: string; mutationId: string }> = [];
        const store = tx.objectStore(SYNC_OUTBOX_STORE);
        for (const raw of sessions) {
          const parsed = sessionSchema.safeParse(raw);
          if (!parsed.success) continue;
          const conversationId = parsed.data.id;
          if (outboxById.has(conversationId)) continue;
          const session = fromStoredSession(parsed.data);
          const meta = metaById.get(conversationId);
          if (
            meta?.localRevision === session.revision &&
            meta.sessionInstanceId === session.sessionInstanceId
          )
            continue;
          const record = syncOutboxSchema.parse({
            conversationId,
            operation: "upsert",
            mutationId: createId("sync"),
            expectedRemoteRevision: meta?.remoteRevision ?? null,
            localRevision: session.revision,
            payload: toSyncConversation(session, conversationId),
            queuedAt: new Date().toISOString(),
            attempts: 0,
            nextAttemptAt: 0,
          });
          store.put(record);
          queuedItems.push({ conversationId, mutationId: record.mutationId });
        }
        setResult(tx, queuedItems);
      };
      sessionsRequest.onsuccess = () => {
        sessions = sessionsRequest.result as unknown[];
        finish();
      };
      metasRequest.onsuccess = () => {
        metas = (metasRequest.result as unknown[]).map((value) => syncMetaSchema.parse(value));
        finish();
      };
      outboxRequest.onsuccess = () => {
        outbox = (outboxRequest.result as unknown[]).map((value) => syncOutboxSchema.parse(value));
        finish();
      };
    },
  );
  await Promise.all(
    queued.map(({ conversationId, mutationId }) =>
      refreshSyncOutboxPayload(conversationId, mutationId),
    ),
  );
}

/** Merge the full sidecar-backed aggregate into an already durable outbox row. */
export async function refreshSyncOutboxPayload(conversationId: string, mutationId?: string) {
  const session = await readStorySession(conversationId);
  if (!session) return;
  const payload = toSyncConversation(session, conversationId);
  await transaction<void>(SYNC_OUTBOX_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_OUTBOX_STORE);
    const current = store.get(conversationId);
    current.onsuccess = () => {
      const value = current.result === undefined ? null : syncOutboxSchema.parse(current.result);
      if (
        !value ||
        value.operation !== "upsert" ||
        (mutationId && value.mutationId !== mutationId) ||
        value.localRevision !== payload.revision
      ) {
        setResult(tx, undefined);
        return;
      }
      const write = store.put({ ...value, payload });
      write.onsuccess = () => setResult(tx, undefined);
    };
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
  await transaction<void>(
    [SYNC_META_STORE, SYNC_OUTBOX_STORE, SYNC_CONFLICT_STORE],
    "readwrite",
    (tx, abort) => {
      const metas = tx.objectStore(SYNC_META_STORE);
      const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
      const conflicts = tx.objectStore(SYNC_CONFLICT_STORE);
      const existingMetaRequest = metas.get(item.conversationId);
      const current = outbox.get(item.conversationId);
      let existingMeta: StoredSyncMeta | null = null;
      let metaReady = false;
      let outboxReady = false;
      const commit = () => {
        if (!metaReady || !outboxReady) return;
        const currentValue = outboxReady
          ? current.result === undefined
            ? null
            : syncOutboxSchema.parse(current.result)
          : null;
        if (!currentValue || currentValue.mutationId !== item.mutationId) {
          if (currentValue) {
            const rebase = outbox.put({
              ...currentValue,
              expectedRemoteRevision:
                currentValue.expectedRemoteRevision === null
                  ? remoteRevision
                  : Math.max(currentValue.expectedRemoteRevision, remoteRevision),
            });
            rebase.onsuccess = () => setResult(tx, undefined);
          } else {
            setResult(tx, undefined);
          }
          return;
        }

        const meta = syncMetaSchema.parse({
          ...(existingMeta ?? {
            conversationId: item.conversationId,
            remoteRevision: null,
            localRevision: null,
          }),
          conversationId: item.conversationId,
          remoteRevision,
          localRevision,
          ...(item.payload?.sessionInstanceId
            ? { sessionInstanceId: item.payload.sessionInstanceId }
            : existingMeta?.sessionInstanceId
              ? { sessionInstanceId: existingMeta.sessionInstanceId }
              : {}),
          ...(existingMeta?.reviewRepair ? { reviewRepair: existingMeta.reviewRepair } : {}),
          updatedAt: new Date().toISOString(),
        });
        const writeMeta = metas.put(meta);
        writeMeta.onsuccess = () => {
          const remove = outbox.delete(item.conversationId);
          remove.onsuccess = () => {
            const resolveConflicts = conflicts.getAll();
            resolveConflicts.onsuccess = () => {
              try {
                for (const raw of resolveConflicts.result as unknown[]) {
                  const conflict = syncConflictSchema.parse(raw);
                  const resolvesUpsert =
                    item.operation === "upsert" &&
                    conflict.operation === "upsert" &&
                    conflict.conflictConversationId === item.conversationId;
                  const resolvesDelete =
                    item.operation === "delete" &&
                    conflict.sourceConversationId === item.conversationId &&
                    conflict.operation === "delete";
                  if (conflict.status !== "open" || (!resolvesUpsert && !resolvesDelete)) {
                    continue;
                  }
                  if (resolvesUpsert) {
                    conflicts.put({ ...conflict, status: "resolved" });
                  } else {
                    // A delete conflict is resolved only after a newer delete
                    // for the same source is accepted (including an idempotent
                    // retry).
                    conflicts.delete(conflict.conflictKey);
                  }
                }
                setResult(tx, undefined);
              } catch (error) {
                abort(error);
              }
            };
          };
        };
      };
      existingMetaRequest.onsuccess = () => {
        existingMeta =
          existingMetaRequest.result === undefined
            ? null
            : syncMetaSchema.parse(existingMetaRequest.result);
        metaReady = true;
        commit();
      };
      current.onsuccess = () => {
        outboxReady = true;
        commit();
      };
    },
  );
}

export async function clearReviewRepairMarker(
  conversationId: string,
  expected?: StoredSyncMeta["reviewRepair"],
) {
  await transaction<void>(SYNC_META_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_META_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const current = request.result === undefined ? null : syncMetaSchema.parse(request.result);
      if (!current?.reviewRepair) {
        setResult(tx, undefined);
        return;
      }
      if (expected && JSON.stringify(current.reviewRepair) !== JSON.stringify(expected)) {
        setResult(tx, undefined);
        return;
      }
      const { reviewRepair: _reviewRepair, ...withoutMarker } = current;
      const write = store.put(syncMetaSchema.parse(withoutMarker));
      write.onsuccess = () => setResult(tx, undefined);
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
    const store = tx.objectStore(SYNC_META_STORE);
    const current = store.get(conversationId);
    current.onsuccess = () => {
      const previous = current.result === undefined ? null : syncMetaSchema.parse(current.result);
      const record = syncMetaSchema.parse({
        conversationId,
        remoteRevision,
        localRevision,
        ...(sessionInstanceId ? { sessionInstanceId } : {}),
        ...(previous?.reviewRepair ? { reviewRepair: previous.reviewRepair } : {}),
        updatedAt: new Date().toISOString(),
      });
      const request = store.put(record);
      request.onsuccess = () => setResult(tx, undefined);
    };
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
  payloadHash?: string,
) {
  await transaction<void>(SYNC_CONFLICT_STORE, "readwrite", (tx) => {
    const request = tx.objectStore(SYNC_CONFLICT_STORE).put(
      syncConflictSchema.parse({
        conflictKey,
        sourceConversationId,
        operation,
        ...(conflictConversationId ? { conflictConversationId } : {}),
        ...(payloadHash ? { payloadHash } : {}),
        status: "open",
        createdAt: new Date().toISOString(),
      }),
    );
    request.onsuccess = () => setResult(tx, undefined);
  });
}

export async function clearConflict(conflictKey: string) {
  await transaction<void>(SYNC_CONFLICT_STORE, "readwrite", (tx) => {
    const request = tx.objectStore(SYNC_CONFLICT_STORE).delete(conflictKey);
    request.onsuccess = () => setResult(tx, undefined);
  });
}

export async function hashSyncPayload(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  // Old non-secure browser contexts may not expose SubtleCrypto. This is only
  // a local idempotency fingerprint; the API still verifies its own SHA-256.
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `${hash.toString(16).padStart(8, "0")}`.repeat(8).slice(0, 64);
}

export async function conflictConversationIdForPayload(
  sourceConversationId: string,
  payload: DailyStorySyncConversation,
) {
  const source = sourceConversationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 72);
  const hash = await hashSyncPayload(payload);
  return `conflict_${source}_${hash}`.slice(0, 159);
}

/**
 * Creates or repairs a conflict copy atomically in the primary database.
 * Review sidecar hydration is intentionally completed by the caller after
 * this transaction, with the repair marker making crashes retryable.
 */
export async function createConflictCopyInTransaction(
  conflictKeyValue: string,
  sourceConversationId: string,
  conflictConversationIdValue: string,
  payloadHash: string,
  copy: StorySession,
) {
  return transaction<"created" | "repaired" | "collision">(
    [SESSION_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE, SYNC_CONFLICT_STORE],
    "readwrite",
    (tx) => {
      const sessions = tx.objectStore(SESSION_STORE);
      const metas = tx.objectStore(SYNC_META_STORE);
      const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
      const conflicts = tx.objectStore(SYNC_CONFLICT_STORE);
      const sessionRequest = sessions.get(conflictConversationIdValue);
      const outboxRequest = outbox.get(conflictConversationIdValue);
      const metaRequest = metas.get(conflictConversationIdValue);
      const conflictRequest = conflicts.get(conflictKeyValue);
      let sessionReady = false;
      let outboxReady = false;
      let metaReady = false;
      let conflictReady = false;
      const finish = () => {
        if (!sessionReady || !outboxReady || !metaReady || !conflictReady) return;
        const existingConflict =
          conflictRequest.result === undefined
            ? null
            : syncConflictSchema.parse(conflictRequest.result);
        const existingSession = sessionRequest.result as unknown;
        const existingOutbox =
          outboxRequest.result === undefined ? null : syncOutboxSchema.parse(outboxRequest.result);
        const existingMeta =
          metaRequest.result === undefined ? null : syncMetaSchema.parse(metaRequest.result);
        if (
          (existingConflict?.payloadHash && existingConflict.payloadHash !== payloadHash) ||
          (existingSession !== undefined &&
            JSON.stringify(existingSession) !==
              JSON.stringify(sessionRecord(copy, conflictConversationIdValue)))
        ) {
          setResult(tx, "collision");
          return;
        }
        if (existingSession === undefined) {
          sessions.put(sessionRecord(copy, conflictConversationIdValue));
        }
        if (!existingOutbox) {
          const payload = toSyncConversation(copy, conflictConversationIdValue);
          outbox.put(
            syncOutboxSchema.parse({
              conversationId: conflictConversationIdValue,
              operation: "upsert",
              mutationId: createId("sync"),
              expectedRemoteRevision: null,
              localRevision: copy.revision,
              payload,
              queuedAt: new Date().toISOString(),
              attempts: 0,
              nextAttemptAt: 0,
            }),
          );
        }
        const marker = {
          ...(existingMeta ?? {
            conversationId: conflictConversationIdValue,
            remoteRevision: null,
            localRevision: null,
          }),
          conversationId: conflictConversationIdValue,
          sessionInstanceId: copy.sessionInstanceId,
          reviewRepair: {
            operation: "upsert" as const,
            remoteRevision: null,
            sessionRevision: copy.revision,
            sessionInstanceId: copy.sessionInstanceId,
            review: copy.review ?? null,
          },
          updatedAt: new Date().toISOString(),
        };
        metas.put(syncMetaSchema.parse(marker));
        conflicts.put(
          syncConflictSchema.parse({
            ...(existingConflict ?? {}),
            conflictKey: conflictKeyValue,
            sourceConversationId,
            operation: "upsert",
            conflictConversationId: conflictConversationIdValue,
            payloadHash,
            status: "open",
            createdAt: existingConflict?.createdAt ?? new Date().toISOString(),
          }),
        );
        setResult(tx, existingSession === undefined ? "created" : "repaired");
      };
      sessionRequest.onsuccess = () => {
        sessionReady = true;
        finish();
      };
      outboxRequest.onsuccess = () => {
        outboxReady = true;
        finish();
      };
      metaRequest.onsuccess = () => {
        metaReady = true;
        finish();
      };
      conflictRequest.onsuccess = () => {
        conflictReady = true;
        finish();
      };
    },
  );
}

export function conflictConversationId(sourceConversationId: string, mutationId: string) {
  const source = sourceConversationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 92);
  const mutation = mutationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(-48);
  return `conflict_${source}_${mutation}`.slice(0, 159);
}

export function conflictKey(sourceConversationId: string, mutationId: string) {
  return `conflict:${sourceConversationId}:${mutationId}`;
}
