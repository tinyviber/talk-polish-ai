import {
  CURRENT,
  LEASE_STORE,
  SESSION_STORE,
  SYNC_META_STORE,
  SYNC_OUTBOX_STORE,
  database,
} from "./internal/database";
import { notifySession } from "./storage-events";
import { SessionConflictError, StorySidecarPersistenceError } from "./errors";
import { createId } from "../types";
import { deriveStableDailyStoryTitle } from "@kotoba/contracts";
import { fromStoredSession, mergeReview, sessionRecord } from "./internal/codecs";
import {
  leaseSchema,
  sessionSchema,
  syncMetaSchema,
  syncOutboxSchema,
  type StoredSession,
  type StoredSyncOutbox,
} from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";
import {
  deleteDailyStoryReview,
  deleteDailyStoryReviewGuarded,
  isSuccessfulSidecarMutation,
  listDailyStoryReviewIds,
  readDailyStoryReview,
  type SidecarMutationStatus,
  writeDailyStoryReviewGuarded,
} from "./story-review-repository";
import { createConversationId } from "../types";
import type {
  DailyReview,
  StorySession,
  StorySessionSnapshot,
  StorySessionSummary,
} from "../types";
import { clearReviewRepairMarker, queueStorySyncInTransaction } from "./story-sync-repository";
import type { StoredSyncMeta } from "./internal/schemas";

type ReviewRepair = NonNullable<StoredSyncMeta["reviewRepair"]>;

type StorySessionWriteResult = {
  session: StorySession;
  previousSessionInstanceId: string | undefined;
  reviewRepair?: ReviewRepair;
};

type SessionReadResult = {
  session: StorySession | null;
  reviewRepair: ReviewRepair | null;
};

function matchingReviewRepair(
  session: StorySession | null,
  meta: StoredSyncMeta | null,
): ReviewRepair | null {
  const repair = meta?.reviewRepair;
  if (
    !session ||
    !repair ||
    repair.operation !== "upsert" ||
    repair.sessionRevision !== session.revision ||
    repair.sessionInstanceId !== session.sessionInstanceId
  ) {
    return null;
  }
  return repair;
}

function reviewFromRepair(repair: ReviewRepair["review"]): DailyReview | null {
  return repair ? (repair as unknown as DailyReview) : null;
}

async function readSessionAndRepair(conversationId: string): Promise<SessionReadResult> {
  return transaction<SessionReadResult>([SESSION_STORE, SYNC_META_STORE], "readonly", (tx) => {
    const sessionRequest = tx.objectStore(SESSION_STORE).get(conversationId);
    const metaRequest = tx.objectStore(SYNC_META_STORE).get(conversationId);
    let sessionLoaded = false;
    let metaLoaded = false;
    const finish = () => {
      if (!sessionLoaded || !metaLoaded) return;
      const rawSession = sessionRequest.result as unknown;
      const session =
        rawSession === undefined ? null : fromStoredSession(sessionSchema.parse(rawSession));
      const rawMeta = metaRequest.result as unknown;
      const meta = rawMeta === undefined ? null : syncMetaSchema.parse(rawMeta);
      setResult(tx, { session, reviewRepair: matchingReviewRepair(session, meta) });
    };
    sessionRequest.onsuccess = () => {
      sessionLoaded = true;
      finish();
    };
    metaRequest.onsuccess = () => {
      metaLoaded = true;
      finish();
    };
  });
}

async function readEffectiveSession(sessionResult: SessionReadResult, conversationId: string) {
  if (!sessionResult.session) return null;
  let sidecar = null;
  try {
    sidecar = await readDailyStoryReview(
      conversationId,
      sessionResult.session.revision,
      sessionResult.session.sessionInstanceId,
    );
  } catch (error) {
    if (!sessionResult.reviewRepair?.review) throw error;
    // A matching sync marker is the durable fallback when the sidecar cannot
    // be read. Without one, do not fabricate a review from the primary record:
    // it only stores suggestions and would turn a transient read failure into
    // a destructive null review on the next local write.
  }
  if (sidecar) return mergeReview(sessionResult.session, sidecar);
  const repairedReview = reviewFromRepair(sessionResult.reviewRepair?.review ?? null);
  return repairedReview
    ? { ...sessionResult.session, review: repairedReview }
    : sessionResult.session;
}

export async function ensureDailyStorage() {
  await database();
  const legacyReview = await readLegacyCurrentReview();
  const migrated = await migrateLegacySession(legacyReview);
  if (migrated) {
    try {
      const status = await persistReviewSidecar(
        migrated.conversationId,
        migrated.session.review ?? null,
        migrated.session.revision,
        migrated.session.sessionInstanceId,
      );
      if (isSuccessfulSidecarMutation(status)) {
        await clearReviewRepairMarker(migrated.conversationId, migrated.reviewRepair);
      }
    } catch {
      // The primary migration and its repair marker are already durable. The
      // review worker will retry the sidecar write later.
    }
  }
  await repairOrphanReviewSidecars();
}

async function readLegacyCurrentReview() {
  const exists = await transaction<boolean>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).get(CURRENT);
    request.onsuccess = () => setResult(tx, request.result !== undefined);
  });
  return exists ? readDailyStoryReview(CURRENT) : null;
}

async function repairOrphanReviewSidecars() {
  let reviewIds: string[];
  let sessionIds: string[];
  try {
    [reviewIds, sessionIds] = await Promise.all([
      listDailyStoryReviewIds(),
      transaction<string[]>(SESSION_STORE, "readonly", (tx) => {
        const request = tx.objectStore(SESSION_STORE).getAllKeys();
        request.onsuccess = () => setResult(tx, (request.result as IDBValidKey[]).map(String));
      }),
    ]);
  } catch {
    // Repair is opportunistic. A stale review connection must not prevent the
    // primary settings/session database from recovering.
    return;
  }
  const sessions = new Set(sessionIds);
  await Promise.all(
    reviewIds
      .filter((id) => !sessions.has(id))
      .map((id) => deleteDailyStoryReview(id).catch(() => {})),
  );
}

async function migrateLegacySession(
  legacyReview: Awaited<ReturnType<typeof readDailyStoryReview>>,
) {
  return transaction<{
    conversationId: string;
    session: StorySession;
    reviewRepair: ReviewRepair;
  } | null>(
    [SESSION_STORE, LEASE_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE],
    "readwrite",
    (tx, abort) => {
      const sessions = tx.objectStore(SESSION_STORE);
      const leases = tx.objectStore(LEASE_STORE);
      const metas = tx.objectStore(SYNC_META_STORE);
      const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
      const sessionRequest = sessions.get(CURRENT);
      const leaseRequest = leases.get(CURRENT);
      const metaRequest = metas.get(CURRENT);
      const outboxRequest = outbox.get(CURRENT);
      let loaded = 0;

      const finish = () => {
        if (loaded !== 4) return;
        try {
          const rawLegacy = sessionRequest.result as unknown;
          if (rawLegacy === undefined) {
            setResult(tx, null);
            return;
          }
          const legacy = sessionSchema.parse(rawLegacy);
          if (metaRequest.result !== undefined || outboxRequest.result !== undefined) {
            abort(new SessionConflictError());
            return;
          }
          const conversationId = createConversationId();
          const sessionInstanceId = legacy.sessionInstanceId ?? createId("session");
          const migrated = fromStoredSession({ ...legacy, id: conversationId, sessionInstanceId });
          const session =
            migrated.review && legacyReview ? mergeReview(migrated, legacyReview) : migrated;
          const reviewRepair = syncMetaSchema.parse({
            conversationId,
            remoteRevision: null,
            localRevision: null,
            sessionInstanceId,
            reviewRepair: {
              operation: "upsert" as const,
              remoteRevision: null,
              sessionRevision: session.revision,
              sessionInstanceId,
              review: session.review ?? null,
            },
            updatedAt: new Date().toISOString(),
          }).reviewRepair!;
          sessions.put(sessionRecord(session, conversationId));
          sessions.delete(CURRENT);
          const legacyLease = leaseRequest.result as
            { id: string; ownerId: string; expiresAt: number } | undefined;
          if (legacyLease) {
            leases.put({ ...legacyLease, id: conversationId });
            leases.delete(CURRENT);
          }
          metas.put(
            syncMetaSchema.parse({
              conversationId,
              remoteRevision: null,
              localRevision: null,
              sessionInstanceId,
              reviewRepair,
              updatedAt: new Date().toISOString(),
            }),
          );
          queueStorySyncInTransaction(tx, conversationId, "upsert", session, () =>
            setResult(tx, { conversationId, session, reviewRepair }),
          );
        } catch (error) {
          abort(error);
        }
      };
      sessionRequest.onsuccess = () => {
        loaded += 1;
        finish();
      };
      leaseRequest.onsuccess = () => {
        loaded += 1;
        finish();
      };
      metaRequest.onsuccess = () => {
        loaded += 1;
        finish();
      };
      outboxRequest.onsuccess = () => {
        loaded += 1;
        finish();
      };
    },
  );
}

export async function listStorySessions(): Promise<StorySessionSummary[]> {
  await ensureDailyStorage();
  const records = await transaction<unknown[]>(SESSION_STORE, "readonly", (tx) => {
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => setResult(tx, request.result as unknown[]);
  });
  const sessions = await Promise.all(
    records.map(async (record): Promise<StorySessionSummary | null> => {
      const parsed = sessionSchema.parse(record);
      const effective = await readEffectiveSession(
        await readSessionAndRepair(parsed.id),
        parsed.id,
      );
      if (!effective) return null;
      return {
        id: parsed.id,
        revision: effective.revision,
        updatedAt: effective.updatedAt,
        phase: effective.phase,
        storyZh: effective.storyZh,
        title: effective.title ?? deriveStableDailyStoryTitle(effective.storyZh),
        review: effective.review ?? null,
      } satisfies StorySessionSummary;
    }),
  );
  return sessions
    .filter((session): session is StorySessionSummary => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readStorySession(conversationId = CURRENT): Promise<StorySession | null> {
  return readEffectiveSession(await readSessionAndRepair(conversationId), conversationId);
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
  ownerId: string,
  claimToken: string,
): Promise<StorySession>;
export function writeStorySession(
  conversationId: string,
  session: StorySessionSnapshot,
  expectedRevision: number | null,
): Promise<StorySession>;
export async function writeStorySession(
  conversationIdOrSession: string | StorySessionSnapshot,
  sessionOrExpectedRevision: StorySessionSnapshot | number | null,
  explicitExpectedRevision?: number | null,
  explicitOwnerId?: string,
  explicitClaimToken?: string,
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
  const claimToken = typeof conversationIdOrSession === "string" ? explicitClaimToken : undefined;
  if (ownerId !== undefined && !claimToken) {
    throw new SessionConflictError();
  }
  const result = await transaction<StorySessionWriteResult>(
    ownerId !== undefined
      ? [SESSION_STORE, LEASE_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE]
      : [SESSION_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE],
    "readwrite",
    (tx, abort) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const metaRequest = tx.objectStore(SYNC_META_STORE).get(conversationId);
      const leaseRequest =
        ownerId !== undefined ? tx.objectStore(LEASE_STORE).get(conversationId) : undefined;
      let storedSessionRecord: StoredSession | undefined;
      let storedMeta: StoredSyncMeta | null = null;
      let leaseRecord: unknown;
      let sessionReady = false;
      let metaReady = false;
      let leaseReady = ownerId === undefined;
      const commit = () => {
        if (!sessionReady || !metaReady || !leaseReady) return;
        try {
          if (ownerId !== undefined) {
            const lease = leaseRecord === undefined ? null : leaseSchema.parse(leaseRecord);
            if (
              lease?.ownerId !== ownerId ||
              lease.claimToken !== claimToken ||
              lease.expiresAt <= Date.now()
            ) {
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
          const matchingRepair = matchingReviewRepair(previous, storedMeta);
          let nextReview: DailyReview | undefined;
          if (snapshotReview && "score" in snapshotReview) {
            nextReview = snapshotReview;
          } else if (matchingRepair?.review) {
            const repairedReview = reviewFromRepair(matchingRepair.review);
            if (repairedReview) {
              nextReview = {
                ...repairedReview,
                ...(snapshotReview ? { suggestions: snapshotReview.suggestions } : {}),
              };
            }
          } else if (snapshotReview) {
            nextReview = {
              score: null,
              comment: null,
              overallFeedback: null,
              rubric: null,
              suggestions: snapshotReview.suggestions,
            };
          }
          const next: StorySession = {
            ...sessionWithoutReview,
            ...(nextReview ? { review: nextReview } : {}),
            schemaVersion: 1,
            revision: (previous?.revision ?? 0) + 1,
            sessionInstanceId: previous?.sessionInstanceId ?? createId("session"),
            updatedAt: new Date().toISOString(),
          };
          const reviewRepair = syncMetaSchema.parse({
            ...(storedMeta ?? {
              conversationId,
              remoteRevision: null,
              localRevision: null,
            }),
            conversationId,
            reviewRepair: {
              operation: "upsert" as const,
              remoteRevision: matchingRepair?.remoteRevision ?? storedMeta?.remoteRevision ?? null,
              sessionRevision: next.revision,
              sessionInstanceId: next.sessionInstanceId,
              review: nextReview ?? null,
            },
            updatedAt: new Date().toISOString(),
          }).reviewRepair;
          const markerWrite = tx.objectStore(SYNC_META_STORE).put(
            syncMetaSchema.parse({
              ...(storedMeta ?? {
                conversationId,
                remoteRevision: null,
                localRevision: null,
              }),
              conversationId,
              reviewRepair,
              updatedAt: new Date().toISOString(),
            }),
          );
          markerWrite.onsuccess = () => {
            const write = store.put(sessionRecord(next, conversationId));
            write.onsuccess = () =>
              queueStorySyncInTransaction(tx, conversationId, "upsert", next, () =>
                setResult(tx, {
                  session: next,
                  previousSessionInstanceId: previous?.sessionInstanceId,
                  reviewRepair,
                }),
              );
          };
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
      metaRequest.onsuccess = () => {
        try {
          const raw = metaRequest.result as unknown;
          storedMeta = raw === undefined ? null : syncMetaSchema.parse(raw);
          metaReady = true;
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
  const { session: persistedSession, previousSessionInstanceId, reviewRepair } = result;
  let sidecarStatus: SidecarMutationStatus;
  try {
    sidecarStatus = await persistReviewSidecar(
      conversationId,
      persistedSession.review ?? null,
      persistedSession.revision,
      persistedSession.sessionInstanceId,
      previousSessionInstanceId,
    );
  } catch {
    try {
      sidecarStatus = await persistReviewSidecar(
        conversationId,
        persistedSession.review ?? null,
        persistedSession.revision,
        persistedSession.sessionInstanceId,
        previousSessionInstanceId,
      );
    } catch {
      notifySession(conversationId, persistedSession.revision);
      throw new StorySidecarPersistenceError(conversationId, "write");
    }
  }
  if (reviewRepair && isSuccessfulSidecarMutation(sidecarStatus)) {
    await clearReviewRepairMarker(conversationId, reviewRepair);
  }
  notifySession(conversationId, persistedSession.revision);
  return persistedSession;
}

type RemoteApplyResult = "applied" | "skipped";

async function applyRemoteSessionRecord(
  conversationId: string,
  incoming: StorySession | null,
  remoteRevision: number,
  expectedLocalRevision: number | null,
): Promise<RemoteApplyResult> {
  const saved = incoming
    ? {
        ...incoming,
        schemaVersion: 1 as const,
        sessionInstanceId: incoming.sessionInstanceId ?? createId("session"),
      }
    : null;
  const result = await transaction<{
    status: RemoteApplyResult;
    reviewRepair: ReviewRepair | null;
    previousSessionInstanceId?: string;
  }>([SESSION_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE], "readwrite", (tx, abort) => {
    const sessions = tx.objectStore(SESSION_STORE);
    const metas = tx.objectStore(SYNC_META_STORE);
    const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
    const metaRequest = metas.get(conversationId);
    const sessionRequest = sessions.get(conversationId);
    const outboxRequest = outbox.get(conversationId);
    let loaded = 0;
    const commit = () => {
      if (loaded !== 3) return;
      try {
        const currentRaw = sessionRequest.result as unknown;
        const current =
          currentRaw === undefined ? null : fromStoredSession(sessionSchema.parse(currentRaw));
        const localMutationExists = outboxRequest.result !== undefined;
        const revisionMatches = (current?.revision ?? null) === expectedLocalRevision;
        if (localMutationExists || !revisionMatches) {
          setResult(tx, { status: "skipped" as const });
          return;
        }

        const previousSessionInstanceId = current?.sessionInstanceId;
        const reviewRepair: ReviewRepair | null =
          saved || current?.sessionInstanceId
            ? {
                operation: saved ? "upsert" : "delete",
                remoteRevision,
                sessionRevision: saved?.revision ?? current?.revision ?? null,
                ...(saved?.sessionInstanceId
                  ? { sessionInstanceId: saved.sessionInstanceId }
                  : current?.sessionInstanceId
                    ? { sessionInstanceId: current.sessionInstanceId }
                    : {}),
                review: saved?.review ?? null,
              }
            : null;
        const existingMeta =
          metaRequest.result === undefined ? null : syncMetaSchema.parse(metaRequest.result);
        const { reviewRepair: _existingRepair, ...metaWithoutRepair } = existingMeta ?? {
          conversationId,
          remoteRevision: null,
          localRevision: null,
        };
        // The marker and primary session/tombstone commit in one transaction.
        // It is written first so a later sidecar failure is repairable.
        const finalMeta = syncMetaSchema.parse({
          ...metaWithoutRepair,
          conversationId,
          remoteRevision,
          localRevision: saved?.revision ?? null,
          ...(saved?.sessionInstanceId ? { sessionInstanceId: saved.sessionInstanceId } : {}),
          ...(reviewRepair ? { reviewRepair } : {}),
          updatedAt: new Date().toISOString(),
        });
        const markerWrite = metas.put(finalMeta);
        markerWrite.onsuccess = () => {
          const write = saved
            ? sessions.put(sessionRecord(saved, conversationId))
            : sessions.delete(conversationId);
          write.onsuccess = () =>
            setResult(tx, {
              status: "applied" as const,
              reviewRepair,
              ...(previousSessionInstanceId ? { previousSessionInstanceId } : {}),
            });
        };
      } catch (error) {
        abort(error);
      }
    };
    metaRequest.onsuccess = () => {
      loaded += 1;
      commit();
    };
    sessionRequest.onsuccess = () => {
      loaded += 1;
      commit();
    };
    outboxRequest.onsuccess = () => {
      loaded += 1;
      commit();
    };
  });
  if (result.status === "skipped") return result.status;
  notifySession(conversationId, saved?.revision ?? remoteRevision, "remote");
  if (!result.reviewRepair) return "applied";
  try {
    const repair = result.reviewRepair;
    let sidecarStatus: SidecarMutationStatus;
    if (saved?.review) {
      sidecarStatus = await persistReviewSidecar(
        conversationId,
        saved.review,
        saved.revision,
        saved.sessionInstanceId,
        result.previousSessionInstanceId,
      );
    } else if (saved) {
      sidecarStatus = await persistReviewSidecar(
        conversationId,
        null,
        saved.revision,
        saved.sessionInstanceId,
        result.previousSessionInstanceId,
      );
    } else if (repair.sessionRevision !== null && repair.sessionInstanceId) {
      sidecarStatus = await deleteDailyStoryReviewGuarded(conversationId, {
        expectedSessionRevision: repair.sessionRevision,
        expectedSessionInstanceId: repair.sessionInstanceId,
      });
    } else {
      sidecarStatus = "generation-mismatch";
    }
    if (!isSuccessfulSidecarMutation(sidecarStatus)) {
      throw new Error(`Sidecar mutation ${sidecarStatus}`);
    }
    await clearReviewRepairMarker(conversationId, repair);
  } catch {
    throw new StorySidecarPersistenceError(conversationId, "write");
  }
  return "applied";
}

export function applyRemoteStorySession(
  conversationId: string,
  incoming: StorySession,
  remoteRevision: number,
  expectedLocalRevision: number | null,
) {
  return applyRemoteSessionRecord(conversationId, incoming, remoteRevision, expectedLocalRevision);
}

export function applyRemoteStoryDeletion(
  conversationId: string,
  remoteRevision: number,
  expectedLocalRevision: number | null,
) {
  return applyRemoteSessionRecord(conversationId, null, remoteRevision, expectedLocalRevision);
}

async function migrateReviewRepairMarker(
  conversationId: string,
  expected: ReviewRepair,
  session: StorySession,
) {
  const migrated = syncMetaSchema.parse({
    conversationId,
    remoteRevision: expected.remoteRevision,
    localRevision: session.revision,
    ...(session.sessionInstanceId ? { sessionInstanceId: session.sessionInstanceId } : {}),
    reviewRepair: {
      ...expected,
      sessionRevision: session.revision,
      ...(session.sessionInstanceId ? { sessionInstanceId: session.sessionInstanceId } : {}),
      review: expected.review
        ? {
            ...expected.review,
            ...(session.review ? { suggestions: session.review.suggestions } : {}),
          }
        : null,
    },
    updatedAt: new Date().toISOString(),
  });
  await transaction<void>(SYNC_META_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(SYNC_META_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const current = request.result === undefined ? null : syncMetaSchema.parse(request.result);
      if (
        !current?.reviewRepair ||
        JSON.stringify(current.reviewRepair) !== JSON.stringify(expected)
      ) {
        setResult(tx, undefined);
        return;
      }
      const write = store.put(
        syncMetaSchema.parse({
          ...current,
          reviewRepair: migrated.reviewRepair,
          updatedAt: new Date().toISOString(),
        }),
      );
      write.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export async function repairStoryReviewFromSync(conversationId: string, repair: ReviewRepair) {
  const state = await transaction<{
    session: StorySession | null;
    outbox: StoredSyncOutbox | null;
  }>([SESSION_STORE, SYNC_OUTBOX_STORE], "readonly", (tx) => {
    const sessionRequest = tx.objectStore(SESSION_STORE).get(conversationId);
    const outboxRequest = tx.objectStore(SYNC_OUTBOX_STORE).get(conversationId);
    let loaded = 0;
    const finish = () => {
      if (loaded !== 2) return;
      const raw = sessionRequest.result as unknown;
      setResult(tx, {
        session: raw === undefined ? null : fromStoredSession(sessionSchema.parse(raw)),
        outbox:
          outboxRequest.result === undefined ? null : syncOutboxSchema.parse(outboxRequest.result),
      });
    };
    sessionRequest.onsuccess = () => {
      loaded += 1;
      finish();
    };
    outboxRequest.onsuccess = () => {
      loaded += 1;
      finish();
    };
  });
  const matchesUpsert =
    state.session?.revision === repair.sessionRevision &&
    state.session?.sessionInstanceId === repair.sessionInstanceId &&
    (!state.outbox || state.outbox.localRevision === repair.sessionRevision);
  const matchesDelete =
    state.session === null &&
    (!state.outbox || (state.outbox.operation === "delete" && state.outbox.localRevision === null));
  const newerSameGenerationSession =
    repair.operation === "upsert" &&
    state.session !== null &&
    state.session.sessionInstanceId === repair.sessionInstanceId &&
    state.session.revision > (repair.sessionRevision ?? -1)
      ? state.session
      : null;
  if (newerSameGenerationSession) {
    await migrateReviewRepairMarker(conversationId, repair, newerSameGenerationSession);
    return false;
  }
  if (
    (repair.operation === "upsert" && !matchesUpsert) ||
    (repair.operation === "delete" && !matchesDelete)
  ) {
    await clearReviewRepairMarker(conversationId, repair);
    return false;
  }
  if (repair.operation === "upsert") {
    if (repair.review) {
      const sidecar = {
        score: repair.review.score,
        comment: repair.review.comment,
        rubric: repair.review.rubric,
        overallFeedback: repair.review.overallFeedback ?? null,
      };
      const existingSidecar = await readDailyStoryReview(conversationId);
      const status = await writeDailyStoryReviewGuarded(
        conversationId,
        {
          ...sidecar,
          ...(repair.sessionRevision !== null ? { sessionRevision: repair.sessionRevision } : {}),
          ...(repair.sessionInstanceId ? { sessionInstanceId: repair.sessionInstanceId } : {}),
        },
        existingSidecar?.sessionInstanceId
          ? { expectedPreviousSessionInstanceId: existingSidecar.sessionInstanceId }
          : undefined,
      );
      if (!isSuccessfulSidecarMutation(status)) return false;
    } else {
      if (repair.sessionRevision !== null && repair.sessionInstanceId) {
        const status = await deleteDailyStoryReviewGuarded(conversationId, {
          expectedSessionRevision: repair.sessionRevision,
          expectedSessionInstanceId: repair.sessionInstanceId,
        });
        if (!isSuccessfulSidecarMutation(status)) return false;
      } else {
        return false;
      }
    }
  } else if (repair.sessionRevision !== null && repair.sessionInstanceId) {
    const status = await deleteDailyStoryReviewGuarded(conversationId, {
      expectedSessionRevision: repair.sessionRevision,
      expectedSessionInstanceId: repair.sessionInstanceId,
    });
    if (!isSuccessfulSidecarMutation(status)) return false;
  } else {
    return false;
  }
  await clearReviewRepairMarker(conversationId, repair);
  return true;
}

export function deleteStorySession(expectedRevision: number | null): Promise<void>;
export function deleteStorySession(
  conversationId: string,
  expectedRevision: number | null,
  ownerId: string,
  claimToken: string,
): Promise<void>;
export function deleteStorySession(
  conversationId: string,
  expectedRevision: number | null,
): Promise<void>;
export async function deleteStorySession(
  conversationIdOrExpectedRevision: string | number | null,
  explicitExpectedRevisionOrOwner?: number | null | string,
  explicitOwnerId?: string,
  explicitClaimToken?: string,
): Promise<void> {
  const hasConversationId = typeof conversationIdOrExpectedRevision === "string";
  const conversationId = hasConversationId ? conversationIdOrExpectedRevision : CURRENT;
  const expectedRevision = hasConversationId
    ? (explicitExpectedRevisionOrOwner as number | null)
    : conversationIdOrExpectedRevision;
  const ownerId = hasConversationId ? explicitOwnerId : undefined;
  const claimToken = hasConversationId ? explicitClaimToken : undefined;
  if (
    (ownerId !== undefined && !claimToken) ||
    (!hasConversationId && typeof explicitExpectedRevisionOrOwner === "string")
  ) {
    throw new SessionConflictError();
  }
  const result = await transaction<{
    revision: number;
    sessionInstanceId?: string;
    reviewRepair?: ReviewRepair;
  } | null>(
    ownerId === undefined
      ? [SESSION_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE]
      : [SESSION_STORE, LEASE_STORE, SYNC_META_STORE, SYNC_OUTBOX_STORE],
    "readwrite",
    (tx, abort) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const metaStore = tx.objectStore(SYNC_META_STORE);
      const metaRequest = metaStore.get(conversationId);
      const leaseRequest =
        ownerId === undefined ? undefined : tx.objectStore(LEASE_STORE).get(conversationId);
      let sessionLoaded = false;
      let metaLoaded = false;
      let leaseLoaded = ownerId === undefined;

      const commit = () => {
        if (!sessionLoaded || !metaLoaded || !leaseLoaded) return;
        try {
          if (ownerId !== undefined) {
            const leaseRecord = leaseRequest?.result as unknown;
            const lease = leaseRecord === undefined ? null : leaseSchema.parse(leaseRecord);
            if (
              lease?.ownerId !== ownerId ||
              lease.claimToken !== claimToken ||
              lease.expiresAt <= Date.now()
            ) {
              abort(new SessionConflictError());
              return;
            }
          }

          const record = request.result as unknown;
          const current =
            record === undefined ? null : fromStoredSession(sessionSchema.parse(record));
          if (current !== null && current.revision !== expectedRevision) {
            abort(new SessionConflictError());
            return;
          }
          const existingMeta =
            metaRequest.result === undefined ? null : syncMetaSchema.parse(metaRequest.result);
          const deletion = store.delete(conversationId);
          deletion.onsuccess = () => {
            if (!current?.sessionInstanceId) {
              queueStorySyncInTransaction(tx, conversationId, "delete", null, () =>
                setResult(tx, null),
              );
              return;
            }
            const reviewRepair = syncMetaSchema.parse({
              ...(existingMeta ?? {
                conversationId,
                remoteRevision: null,
                localRevision: null,
              }),
              conversationId,
              reviewRepair: {
                operation: "delete" as const,
                remoteRevision: existingMeta?.remoteRevision ?? null,
                sessionRevision: current.revision,
                sessionInstanceId: current.sessionInstanceId,
                review: null,
              },
              updatedAt: new Date().toISOString(),
            }).reviewRepair;
            const markerWrite = metaStore.put(
              syncMetaSchema.parse({
                ...(existingMeta ?? {
                  conversationId,
                  remoteRevision: null,
                  localRevision: null,
                }),
                conversationId,
                reviewRepair,
                updatedAt: new Date().toISOString(),
              }),
            );
            markerWrite.onsuccess = () =>
              queueStorySyncInTransaction(tx, conversationId, "delete", null, () =>
                setResult(tx, {
                  revision: current.revision,
                  sessionInstanceId: current.sessionInstanceId,
                  reviewRepair,
                }),
              );
          };
        } catch (error) {
          abort(error);
        }
      };

      request.onsuccess = () => {
        sessionLoaded = true;
        commit();
      };
      metaRequest.onsuccess = () => {
        metaLoaded = true;
        commit();
      };
      if (leaseRequest) {
        leaseRequest.onsuccess = () => {
          leaseLoaded = true;
          commit();
        };
      }
    },
  );
  notifySession(conversationId, (expectedRevision ?? 0) + 1);
  if (result?.reviewRepair && result.sessionInstanceId) {
    let sidecarStatus: SidecarMutationStatus;
    try {
      sidecarStatus = await deleteDailyStoryReviewGuarded(conversationId, {
        expectedSessionRevision: result.revision,
        expectedSessionInstanceId: result.sessionInstanceId,
      });
    } catch {
      try {
        sidecarStatus = await deleteDailyStoryReviewGuarded(conversationId, {
          expectedSessionRevision: result.revision,
          expectedSessionInstanceId: result.sessionInstanceId,
        });
      } catch {
        throw new StorySidecarPersistenceError(conversationId, "delete");
      }
    }
    if (isSuccessfulSidecarMutation(sidecarStatus)) {
      await clearReviewRepairMarker(conversationId, result.reviewRepair);
    }
  }
}

async function persistReviewSidecar(
  conversationId: string,
  review: DailyReview | null,
  sessionRevision: number,
  sessionInstanceId?: string,
  expectedPreviousSessionInstanceId?: string,
): Promise<SidecarMutationStatus> {
  if (review) {
    const writeOptions = expectedPreviousSessionInstanceId
      ? { expectedPreviousSessionInstanceId }
      : undefined;
    return writeDailyStoryReviewGuarded(
      conversationId,
      {
        score: review.score,
        comment: review.comment,
        ...(review.overallFeedback !== undefined
          ? { overallFeedback: review.overallFeedback }
          : {}),
        rubric: review.rubric,
        sessionRevision,
        ...(sessionInstanceId ? { sessionInstanceId } : {}),
      },
      writeOptions,
    );
  }
  if (!sessionInstanceId) return "generation-mismatch";
  return deleteDailyStoryReviewGuarded(conversationId, {
    expectedSessionRevision: sessionRevision,
    expectedSessionInstanceId: sessionInstanceId,
    ...(expectedPreviousSessionInstanceId ? { expectedPreviousSessionInstanceId } : {}),
  });
}
