import { REVIEW_STORE } from "./internal/database";
import { sidecarRecord, type DailyReviewSidecar } from "./internal/codecs";
import { storedReviewSidecarSchema } from "./internal/schemas";
import { reviewTransaction, setResult } from "./internal/transaction";

export type { DailyReviewSidecar } from "./internal/codecs";

export async function readDailyStoryReview(
  conversationId: string,
  expectedSessionRevision?: number,
  expectedSessionInstanceId?: string,
): Promise<DailyReviewSidecar | null> {
  const result = await reviewTransaction<DailyReviewSidecar | null>("readonly", (tx) => {
    const request = tx.objectStore(REVIEW_STORE).get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      if (record === undefined) {
        setResult(tx, null);
        return;
      }
      const parsed = storedReviewSidecarSchema.parse(record);
      if (
        expectedSessionRevision !== undefined &&
        parsed.sessionRevision !== undefined &&
        parsed.sessionRevision !== expectedSessionRevision
      ) {
        setResult(tx, null);
        return;
      }
      if (
        expectedSessionInstanceId !== undefined &&
        parsed.sessionInstanceId !== expectedSessionInstanceId
      ) {
        setResult(tx, null);
        return;
      }
      if (
        expectedSessionRevision !== undefined &&
        expectedSessionInstanceId === undefined &&
        parsed.sessionInstanceId !== undefined
      ) {
        setResult(tx, null);
        return;
      }
      // A pre-migration sidecar has no revision. Never merge it into a newly
      // created revision-1 session; that is the dangerous session-id reuse case.
      if (expectedSessionRevision === 1 && parsed.sessionRevision === undefined) {
        setResult(tx, null);
        return;
      }
      setResult(tx, {
        score: parsed.score,
        comment: parsed.comment,
        rubric: parsed.rubric,
        ...(parsed.sessionRevision !== undefined
          ? { sessionRevision: parsed.sessionRevision }
          : {}),
        ...(parsed.sessionInstanceId ? { sessionInstanceId: parsed.sessionInstanceId } : {}),
      });
    };
  });
  return result;
}

export async function writeDailyStoryReview(
  conversationId: string,
  review: DailyReviewSidecar,
): Promise<DailyReviewSidecar> {
  const normalized = {
    score: review.score ?? null,
    comment: review.comment ?? null,
    rubric: review.rubric ?? null,
    ...(review.sessionRevision !== undefined ? { sessionRevision: review.sessionRevision } : {}),
    ...(review.sessionInstanceId ? { sessionInstanceId: review.sessionInstanceId } : {}),
  } satisfies DailyReviewSidecar;
  if (normalized.score === null && normalized.comment === null && normalized.rubric === null) {
    await deleteDailyStoryReview(conversationId);
    return normalized;
  }
  await reviewTransaction<void>("readwrite", (tx, abort) => {
    try {
      const request = tx.objectStore(REVIEW_STORE).put(sidecarRecord(conversationId, normalized));
      request.onsuccess = () => setResult(tx, undefined);
    } catch (error) {
      abort(error);
    }
  });
  return normalized;
}

export async function deleteDailyStoryReview(
  conversationId: string,
  expectedSessionRevision?: number,
  expectedSessionInstanceId?: string,
): Promise<void> {
  await reviewTransaction<void>("readwrite", (tx) => {
    const store = tx.objectStore(REVIEW_STORE);
    if (expectedSessionRevision === undefined && expectedSessionInstanceId === undefined) {
      const request = store.delete(conversationId);
      request.onsuccess = () => setResult(tx, undefined);
      return;
    }
    // A generation-scoped cleanup must fail closed if either identity is
    // absent. Legacy sidecars are repaired separately and must not be deleted
    // by a mutation that cannot prove which session created them.
    if (expectedSessionRevision === undefined || expectedSessionInstanceId === undefined) {
      setResult(tx, undefined);
      return;
    }
    const read = store.get(conversationId);
    read.onsuccess = () => {
      const record = read.result as unknown;
      if (record === undefined) {
        setResult(tx, undefined);
        return;
      }
      const parsed = storedReviewSidecarSchema.parse(record);
      if (
        parsed.sessionRevision !== expectedSessionRevision ||
        parsed.sessionInstanceId !== expectedSessionInstanceId
      ) {
        setResult(tx, undefined);
        return;
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  });
}

/** Best-effort startup repair for sidecars left by a committed session delete. */
export async function listDailyStoryReviewIds(): Promise<string[]> {
  return reviewTransaction<string[]>("readonly", (tx) => {
    const request = tx.objectStore(REVIEW_STORE).getAllKeys();
    request.onsuccess = () => setResult(tx, (request.result as IDBValidKey[]).map(String));
  });
}
