import { CURRENT, LEASE_STORE, SESSION_STORE, database } from "./internal/database";
import { notifySession } from "./storage-events";
import { SessionConflictError, StorySidecarPersistenceError } from "./errors";
import { createId } from "../types";
import { deriveStableDailyStoryTitle } from "@kotoba/contracts";
import { fromStoredSession, mergeReview, sessionRecord } from "./internal/codecs";
import { leaseSchema, sessionSchema, type StoredSession } from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";
import {
  deleteDailyStoryReview,
  listDailyStoryReviewIds,
  readDailyStoryReview,
  writeDailyStoryReview,
} from "./story-review-repository";
import { createConversationId } from "../types";
import type {
  DailyReview,
  StorySession,
  StorySessionSnapshot,
  StorySessionSummary,
} from "../types";

type StorySessionWriteResult = {
  session: StorySession;
  previousSessionInstanceId: string | undefined;
};

export async function ensureDailyStorage() {
  await database();
  await migrateLegacySession();
  await repairOrphanReviewSidecars();
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
      const review = await readDailyStoryReview(
        parsed.id,
        parsed.revision,
        parsed.sessionInstanceId,
      );
      return {
        id: parsed.id,
        revision: parsed.revision,
        updatedAt: parsed.updatedAt,
        phase: parsed.phase,
        storyZh: parsed.storyZh,
        title: session.title ?? deriveStableDailyStoryTitle(session.storyZh),
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
  return session
    ? mergeReview(
        session,
        await readDailyStoryReview(conversationId, session.revision, session.sessionInstanceId),
      )
    : null;
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
    ownerId !== undefined ? [SESSION_STORE, LEASE_STORE] : SESSION_STORE,
    "readwrite",
    (tx, abort) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const leaseRequest =
        ownerId !== undefined ? tx.objectStore(LEASE_STORE).get(conversationId) : undefined;
      let storedSessionRecord: StoredSession | undefined;
      let leaseRecord: unknown;
      let sessionReady = false;
      let leaseReady = ownerId === undefined;
      const commit = () => {
        if (!sessionReady || !leaseReady) return;
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
                          overallFeedback: null,
                          rubric: null,
                          suggestions: snapshotReview.suggestions,
                        },
                }
              : {}),
            schemaVersion: 1,
            revision: (previous?.revision ?? 0) + 1,
            sessionInstanceId: previous?.sessionInstanceId ?? createId("session"),
            updatedAt: new Date().toISOString(),
          };
          const write = store.put(sessionRecord(next, conversationId));
          write.onsuccess = () =>
            setResult(tx, {
              session: next,
              previousSessionInstanceId: previous?.sessionInstanceId,
            });
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
  const { session: persistedSession, previousSessionInstanceId } = result;
  try {
    await persistReviewSidecar(
      conversationId,
      persistedSession.review ?? null,
      persistedSession.revision,
      persistedSession.sessionInstanceId,
      previousSessionInstanceId,
    );
  } catch {
    try {
      await persistReviewSidecar(
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
  notifySession(conversationId, persistedSession.revision);
  return persistedSession;
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
  const result = await transaction<{ revision: number; sessionInstanceId?: string } | null>(
    ownerId === undefined ? SESSION_STORE : [SESSION_STORE, LEASE_STORE],
    "readwrite",
    (tx, abort) => {
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(conversationId);
      const leaseRequest =
        ownerId === undefined ? undefined : tx.objectStore(LEASE_STORE).get(conversationId);
      let sessionLoaded = false;
      let leaseLoaded = ownerId === undefined;

      const commit = () => {
        if (!sessionLoaded || !leaseLoaded) return;
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
          const deletion = store.delete(conversationId);
          deletion.onsuccess = () =>
            setResult(
              tx,
              current
                ? { revision: current.revision, sessionInstanceId: current.sessionInstanceId }
                : null,
            );
        } catch (error) {
          abort(error);
        }
      };

      request.onsuccess = () => {
        sessionLoaded = true;
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
  if (result?.sessionInstanceId) {
    try {
      await deleteDailyStoryReview(conversationId, result.revision, result.sessionInstanceId);
    } catch {
      try {
        await deleteDailyStoryReview(conversationId, result.revision, result.sessionInstanceId);
      } catch {
        throw new StorySidecarPersistenceError(conversationId, "delete");
      }
    }
  }
}

async function persistReviewSidecar(
  conversationId: string,
  review: DailyReview | null,
  sessionRevision: number,
  sessionInstanceId?: string,
  expectedPreviousSessionInstanceId?: string,
) {
  if (review) {
    const writeOptions = expectedPreviousSessionInstanceId
      ? { expectedPreviousSessionInstanceId }
      : undefined;
    await writeDailyStoryReview(
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
  } else {
    if (sessionInstanceId) {
      await deleteDailyStoryReview(conversationId, sessionRevision, sessionInstanceId);
    }
  }
}
