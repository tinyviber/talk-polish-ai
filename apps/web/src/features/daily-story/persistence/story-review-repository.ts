import { REVIEW_STORE } from "./internal/database";
import { sidecarRecord, type DailyReviewSidecar } from "./internal/codecs";
import { storedReviewSidecarSchema } from "./internal/schemas";
import { reviewTransaction, setResult } from "./internal/transaction";

export type { DailyReviewSidecar } from "./internal/codecs";

export type SidecarMutationStatus =
  "applied" | "already-matching" | "already-absent" | "stale" | "generation-mismatch";

export type GuardedSidecarMutationOptions = {
  expectedPreviousSessionInstanceId?: string;
  expectedSessionRevision?: number;
  expectedSessionInstanceId?: string;
};

export function isSuccessfulSidecarMutation(status: SidecarMutationStatus) {
  return status === "applied" || status === "already-matching" || status === "already-absent";
}

export async function readDailyStoryReview(
  conversationId: string,
  expectedSessionRevision?: number,
  expectedSessionInstanceId?: string,
): Promise<DailyReviewSidecar | null> {
  const result = await reviewTransaction<DailyReviewSidecar | null>("readonly", (tx, abort) => {
    const request = tx.objectStore(REVIEW_STORE).get(conversationId);
    request.onsuccess = () => {
      try {
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
          overallFeedback: parsed.overallFeedback ?? null,
          rubric: parsed.rubric,
          ...(parsed.sessionRevision !== undefined
            ? { sessionRevision: parsed.sessionRevision }
            : {}),
          ...(parsed.sessionInstanceId ? { sessionInstanceId: parsed.sessionInstanceId } : {}),
        });
      } catch (error) {
        abort(error);
      }
    };
  });
  return result;
}

export async function writeDailyStoryReview(
  conversationId: string,
  review: DailyReviewSidecar,
  options: { expectedPreviousSessionInstanceId?: string } = {},
): Promise<DailyReviewSidecar> {
  const normalized = {
    score: review.score ?? null,
    comment: review.comment ?? null,
    overallFeedback: review.overallFeedback ?? null,
    rubric: review.rubric ?? null,
    ...(review.sessionRevision !== undefined ? { sessionRevision: review.sessionRevision } : {}),
    ...(review.sessionInstanceId ? { sessionInstanceId: review.sessionInstanceId } : {}),
  } satisfies DailyReviewSidecar;
  if (
    normalized.score === null &&
    normalized.comment === null &&
    normalized.overallFeedback === null &&
    normalized.rubric === null
  ) {
    await deleteDailyStoryReviewGuarded(conversationId, {
      ...(options.expectedPreviousSessionInstanceId
        ? { expectedPreviousSessionInstanceId: options.expectedPreviousSessionInstanceId }
        : {}),
      ...(normalized.sessionRevision !== undefined
        ? { expectedSessionRevision: normalized.sessionRevision }
        : {}),
      ...(normalized.sessionInstanceId
        ? { expectedSessionInstanceId: normalized.sessionInstanceId }
        : {}),
    });
    return normalized;
  }

  await writeDailyStoryReviewGuarded(conversationId, normalized, options);
  return normalized;
}

export async function writeDailyStoryReviewGuarded(
  conversationId: string,
  review: DailyReviewSidecar,
  options: GuardedSidecarMutationOptions = {},
): Promise<SidecarMutationStatus> {
  const normalized = {
    score: review.score ?? null,
    comment: review.comment ?? null,
    overallFeedback: review.overallFeedback ?? null,
    rubric: review.rubric ?? null,
    ...(review.sessionRevision !== undefined ? { sessionRevision: review.sessionRevision } : {}),
    ...(review.sessionInstanceId ? { sessionInstanceId: review.sessionInstanceId } : {}),
  } satisfies DailyReviewSidecar;
  if (
    normalized.score === null &&
    normalized.comment === null &&
    normalized.overallFeedback === null &&
    normalized.rubric === null
  ) {
    return deleteDailyStoryReviewGuarded(conversationId, {
      ...options,
      ...(normalized.sessionRevision !== undefined
        ? { expectedSessionRevision: normalized.sessionRevision }
        : {}),
      ...(normalized.sessionInstanceId
        ? { expectedSessionInstanceId: normalized.sessionInstanceId }
        : {}),
    });
  }

  return reviewTransaction<SidecarMutationStatus>("readwrite", (tx, abort) => {
    const store = tx.objectStore(REVIEW_STORE);
    const read = store.get(conversationId);
    read.onsuccess = () => {
      try {
        const record = read.result as unknown;
        if (record === undefined) {
          const request = store.put(sidecarRecord(conversationId, normalized));
          request.onsuccess = () => setResult(tx, "applied");
          return;
        }

        const current = storedReviewSidecarSchema.parse(record);
        const sameGeneration =
          normalized.sessionInstanceId !== undefined &&
          current.sessionInstanceId === normalized.sessionInstanceId;
        if (sameGeneration) {
          if (
            normalized.sessionRevision !== undefined &&
            current.sessionRevision !== undefined &&
            current.sessionRevision > normalized.sessionRevision
          ) {
            setResult(tx, "stale");
            return;
          }
          if (
            JSON.stringify(sidecarRecord(conversationId, normalized)) === JSON.stringify(current)
          ) {
            setResult(tx, "already-matching");
            return;
          }
          const request = store.put(sidecarRecord(conversationId, normalized));
          request.onsuccess = () => setResult(tx, "applied");
          return;
        }

        if (
          normalized.sessionInstanceId === undefined ||
          current.sessionInstanceId !== options.expectedPreviousSessionInstanceId
        ) {
          // A different session generation may replace the previous one only
          // when the caller proves which previous generation it saw.
          setResult(tx, "generation-mismatch");
          return;
        }
        const request = store.put(sidecarRecord(conversationId, normalized));
        request.onsuccess = () => setResult(tx, "applied");
      } catch (error) {
        abort(error);
      }
    };
  });
}

export async function deleteDailyStoryReview(
  conversationId: string,
  expectedSessionRevision?: number,
  expectedSessionInstanceId?: string,
): Promise<void> {
  await deleteDailyStoryReviewGuarded(conversationId, {
    ...(expectedSessionRevision === undefined && expectedSessionInstanceId === undefined
      ? { allowUnconditional: true }
      : {}),
    ...(expectedSessionRevision !== undefined ? { expectedSessionRevision } : {}),
    ...(expectedSessionInstanceId ? { expectedSessionInstanceId } : {}),
  });
}

export async function deleteDailyStoryReviewGuarded(
  conversationId: string,
  options: GuardedSidecarMutationOptions & { allowUnconditional?: boolean } = {},
): Promise<SidecarMutationStatus> {
  return reviewTransaction<SidecarMutationStatus>("readwrite", (tx, abort) => {
    const store = tx.objectStore(REVIEW_STORE);
    const read = store.get(conversationId);
    read.onsuccess = () => {
      try {
        const record = read.result as unknown;
        if (record === undefined) {
          setResult(tx, "already-absent");
          return;
        }
        const parsed = storedReviewSidecarSchema.parse(record);
        if (
          options.allowUnconditional &&
          options.expectedSessionRevision === undefined &&
          options.expectedSessionInstanceId === undefined
        ) {
          const deletion = store.delete(conversationId);
          deletion.onsuccess = () => setResult(tx, "applied");
          return;
        }

        // A generation-scoped cleanup must fail closed if either identity is
        // absent. Legacy sidecars are repaired separately and must not be
        // deleted by a mutation that cannot prove which session created them.
        if (
          options.expectedSessionRevision === undefined ||
          options.expectedSessionInstanceId === undefined
        ) {
          setResult(tx, "generation-mismatch");
          return;
        }

        if (parsed.sessionInstanceId === options.expectedSessionInstanceId) {
          if (parsed.sessionRevision === undefined) {
            setResult(tx, "generation-mismatch");
            return;
          }
          if (parsed.sessionRevision > options.expectedSessionRevision) {
            setResult(tx, "stale");
            return;
          }
          const deletion = store.delete(conversationId);
          deletion.onsuccess = () => setResult(tx, "applied");
          return;
        }

        if (parsed.sessionInstanceId !== options.expectedPreviousSessionInstanceId) {
          setResult(tx, "generation-mismatch");
          return;
        }
        const deletion = store.delete(conversationId);
        deletion.onsuccess = () => setResult(tx, "applied");
      } catch (error) {
        abort(error);
      }
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
