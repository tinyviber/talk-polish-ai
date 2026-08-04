import { and, asc, eq, gt, lt, lte } from "drizzle-orm";
import { closeDatabase, db } from "./client";
import { audioPlaybackReferences, storageCleanupJobs } from "./schema";
import { withDb } from "../http/with-db";
import { providers } from "../providers";
import { StorageError, type AudioStorageProvider } from "../providers/storage";
import { randomUUID } from "node:crypto";

export const CLEANUP_MAX_ATTEMPTS = 5;
export const CLEANUP_BATCH_SIZE = 25;
export const ORPHAN_STORAGE_GRACE_MS = 24 * 60 * 60 * 1000;
const DEAD_LETTER_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export type CleanupRunResult = {
  processed: number;
  deleted: number;
  retried: number;
  deadLettered: number;
};

/**
 * One bounded cleanup pass. Run from a scheduler or a small sidecar worker;
 * no audio bytes or provider credentials enter PostgreSQL.
 */
export async function processStorageCleanupJobs(
  storage = providers().storage,
  now = new Date(),
  batchSize = CLEANUP_BATCH_SIZE,
): Promise<CleanupRunResult> {
  await processExpiredAudioReferences(storage, now);
  const jobs = await db()
    .select()
    .from(storageCleanupJobs)
    .where(
      and(
        lte(storageCleanupJobs.nextAttemptAt, now),
        lt(storageCleanupJobs.attempts, CLEANUP_MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(storageCleanupJobs.nextAttemptAt))
    .limit(batchSize);

  const result: CleanupRunResult = {
    processed: 0,
    deleted: 0,
    retried: 0,
    deadLettered: 0,
  };

  for (const job of jobs) {
    result.processed += 1;
    try {
      const activeReferences = await db()
        .select({ id: audioPlaybackReferences.id })
        .from(audioPlaybackReferences)
        .where(
          and(
            eq(audioPlaybackReferences.storageKey, job.storageKey),
            gt(audioPlaybackReferences.expiresAt, now),
          ),
        )
        .limit(1);
      if (activeReferences.length > 0) {
        await db().delete(storageCleanupJobs).where(eq(storageCleanupJobs.id, job.id));
        continue;
      }
      await storage.remove(job.storageKey);
      await db().delete(storageCleanupJobs).where(eq(storageCleanupJobs.id, job.id));
      result.deleted += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const deadLetter = attempts >= CLEANUP_MAX_ATTEMPTS;
      const nextAttemptAt = new Date(
        now.getTime() + (deadLetter ? DEAD_LETTER_DELAY_MS : retryDelayMs(attempts)),
      );
      await db()
        .update(storageCleanupJobs)
        .set({ attempts, nextAttemptAt })
        .where(eq(storageCleanupJobs.id, job.id));
      if (deadLetter) result.deadLettered += 1;
      else result.retried += 1;
      console.warn("[storage-cleanup] remove failed", {
        provider: storage.name,
        jobId: job.id,
        reason: job.reason,
        errorCode: error instanceof StorageError ? error.code : "provider_error",
        attempts,
        deadLetter,
      });
    }
  }

  return result;
}

/** Remove expired opaque TTS references and reclaim unreferenced TTS objects. */
export async function processExpiredAudioReferences(
  storage = providers().storage,
  now = new Date(),
  batchSize = CLEANUP_BATCH_SIZE,
) {
  const expired = await db()
    .select({ id: audioPlaybackReferences.id, storageKey: audioPlaybackReferences.storageKey })
    .from(audioPlaybackReferences)
    .where(lte(audioPlaybackReferences.expiresAt, now))
    .limit(batchSize);
  const keys = [...new Set(expired.map((row) => row.storageKey))];

  for (const storageKey of keys) {
    const active = await db()
      .select({ id: audioPlaybackReferences.id })
      .from(audioPlaybackReferences)
      .where(
        and(
          eq(audioPlaybackReferences.storageKey, storageKey),
          gt(audioPlaybackReferences.expiresAt, now),
        ),
      )
      .limit(1);
    if (active.length === 0) {
      await removeOrQueueStorage(storage, storageKey, "expired-tts-reference");
    }
    await db()
      .delete(audioPlaybackReferences)
      .where(
        and(
          eq(audioPlaybackReferences.storageKey, storageKey),
          lte(audioPlaybackReferences.expiresAt, now),
        ),
      );
  }
}

export async function removeOrQueueStorage(
  storage: AudioStorageProvider,
  storageKey: string,
  reason: string,
  notBefore?: Date,
) {
  if (notBefore && notBefore.getTime() > Date.now()) {
    await queueStorageCleanup(storageKey, reason, notBefore);
    return;
  }
  try {
    await storage.remove(storageKey);
  } catch (error) {
    console.error("[storage] cleanup failed", {
      provider: storage.name,
      reason,
      storageKey,
      errorCode: error instanceof StorageError ? error.code : "provider_error",
    });
    await queueStorageCleanup(storageKey, reason, new Date());
  }
}

async function queueStorageCleanup(storageKey: string, reason: string, nextAttemptAt: Date) {
  try {
    await withDb("queueStorageCleanup", () =>
      db()
        .insert(storageCleanupJobs)
        .values({ id: `cln_${randomUUID()}`, storageKey, reason, nextAttemptAt }),
    );
  } catch (queueError) {
    console.error("[storage] cleanup intent could not be persisted", {
      reason,
      storageKey,
      error: queueError instanceof Error ? queueError.message : "database_error",
    });
  }
}

function retryDelayMs(attempt: number) {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
}

if (import.meta.main) {
  processStorageCleanupJobs()
    .then((result) => {
      console.log("storage cleanup complete", result);
      return closeDatabase();
    })
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("storage cleanup failed", error instanceof Error ? error.message : "unknown");
      await closeDatabase();
      process.exit(1);
    });
}
