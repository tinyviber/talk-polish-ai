import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attemptResults,
  audioRecordings,
  practiceSessions,
  progressEvents,
  speakingAttempts,
  storageCleanupJobs,
} from "../../db/schema";
import { ApiError } from "../../http/errors";
import { withDb } from "../../http/with-db";
import { FAILED_ATTEMPT_AUDIO_RETENTION_MS } from "../../db/storage-cleanup";

export type StoredAudio = {
  buffer: Buffer;
  mimeType: string;
};

export const attemptRepository = {
  async findSession(id: string) {
    const rows = await withDb("loadSessionForAttempt", () =>
      db().select().from(practiceSessions).where(eq(practiceSessions.id, id)),
    );
    return rows[0];
  },
  async findByClientId(learnerId: string, clientAttemptId: string) {
    const rows = await withDb("findIdempotentAttempt", () =>
      db()
        .select({
          id: speakingAttempts.id,
          status: speakingAttempts.status,
          sessionId: speakingAttempts.sessionId,
          attemptIndex: speakingAttempts.attemptIndex,
          clientAttemptId: speakingAttempts.clientAttemptId,
          createdAt: speakingAttempts.createdAt,
        })
        .from(speakingAttempts)
        .where(
          and(
            eq(speakingAttempts.learnerId, learnerId),
            eq(speakingAttempts.clientAttemptId, clientAttemptId),
          ),
        ),
    );
    return rows[0];
  },
  async findBySessionAndIndex(sessionId: string, attemptIndex: 1 | 2) {
    const rows = await withDb("findAttemptSlot", () =>
      db()
        .select({
          id: speakingAttempts.id,
          status: speakingAttempts.status,
          sessionId: speakingAttempts.sessionId,
          attemptIndex: speakingAttempts.attemptIndex,
          clientAttemptId: speakingAttempts.clientAttemptId,
          createdAt: speakingAttempts.createdAt,
        })
        .from(speakingAttempts)
        .where(
          and(
            eq(speakingAttempts.sessionId, sessionId),
            eq(speakingAttempts.attemptIndex, attemptIndex),
          ),
        )
        .limit(1),
    );
    return rows[0];
  },
  async insertProcessing(input: {
    attemptId: string;
    sessionId: string;
    learnerId: string;
    attemptIndex: 1 | 2;
    clientAttemptId: string | null;
    durationSec: number;
    mocked: boolean;
    storageKey: string | null;
    audio: StoredAudio | null;
  }) {
    const reclaimedStorageKeys: string[] = [];
    let audioId: string | null = null;
    await withDb("insertAttempt", () =>
      db().transaction(async (tx) => {
        const existing = await tx
          .select({
            id: speakingAttempts.id,
            attemptIndex: speakingAttempts.attemptIndex,
            status: speakingAttempts.status,
            createdAt: speakingAttempts.createdAt,
            audioId: speakingAttempts.audioId,
          })
          .from(speakingAttempts)
          .where(eq(speakingAttempts.sessionId, input.sessionId));
        const sameIndex = existing.find((row) => row.attemptIndex === input.attemptIndex);
        if (input.attemptIndex === 2) {
          const firstAttempt = existing.find(
            (row) => row.attemptIndex === 1 && row.status === "ready",
          );
          if (!firstAttempt)
            throw ApiError.conflict("Attempt 1 must be ready before recording attempt 2.");
        }
        if (sameIndex) {
          const recoverable = sameIndex.status === "failed";
          if (!recoverable)
            throw ApiError.conflict(
              `Attempt ${input.attemptIndex} already exists for this session.`,
            );
          if (sameIndex.audioId) {
            const audioRows = await tx
              .select({ storageKey: audioRecordings.storageKey })
              .from(audioRecordings)
              .where(eq(audioRecordings.id, sameIndex.audioId));
            if (audioRows[0]) reclaimedStorageKeys.push(audioRows[0].storageKey);
            await tx.delete(audioRecordings).where(eq(audioRecordings.id, sameIndex.audioId));
          }
          await tx.delete(speakingAttempts).where(eq(speakingAttempts.id, sameIndex.id));
        }
        if (input.storageKey && input.audio) {
          audioId = `aud_${randomUUID()}`;
          await tx.insert(audioRecordings).values({
            id: audioId,
            storageKey: input.storageKey,
            mimeType: input.audio.mimeType.split(";")[0]!.trim().toLowerCase(),
            sizeBytes: input.audio.buffer.byteLength,
            durationSec: input.durationSec,
          });
        }
        await tx.insert(speakingAttempts).values({
          id: input.attemptId,
          sessionId: input.sessionId,
          learnerId: input.learnerId,
          attemptIndex: input.attemptIndex,
          clientAttemptId: input.clientAttemptId,
          status: "processing",
          durationSec: input.durationSec,
          mocked: input.mocked,
          audioId,
        });
      }),
    );
    return { audioId, reclaimedStorageKeys };
  },
  async findRaced(learnerId: string, clientAttemptId: string) {
    const rows = await withDb("recoverIdempotentAttemptRace", () =>
      db()
        .select({
          id: speakingAttempts.id,
          sessionId: speakingAttempts.sessionId,
          attemptIndex: speakingAttempts.attemptIndex,
        })
        .from(speakingAttempts)
        .where(
          and(
            eq(speakingAttempts.learnerId, learnerId),
            eq(speakingAttempts.clientAttemptId, clientAttemptId),
          ),
        ),
    );
    return rows[0];
  },
  async persistResult(input: {
    attemptId: string;
    learnerId: string;
    sessionId: string;
    attemptIndex: 1 | 2;
    transcript: string;
    transcriptionProvider: string;
    transcription: unknown;
    assessmentProvider: string;
    overallScore: number;
    feedback: unknown;
  }) {
    await withDb("persistAttemptResult", () =>
      db().transaction(async (tx) => {
        const claimed = await tx
          .update(speakingAttempts)
          .set({ status: "ready" })
          .where(
            and(
              eq(speakingAttempts.id, input.attemptId),
              eq(speakingAttempts.status, "processing"),
            ),
          )
          .returning({ id: speakingAttempts.id });
        if (claimed.length === 0) {
          throw ApiError.conflict("Attempt processing was already recovered. Please retry.");
        }
        await tx.insert(attemptResults).values({
          attemptId: input.attemptId,
          transcript: input.transcript,
          transcriptionProvider: input.transcriptionProvider,
          transcription: input.transcription,
          assessmentProvider: input.assessmentProvider,
          overallScore: input.overallScore,
          feedback: input.feedback,
        });
        await tx.insert(progressEvents).values({
          id: `prg_${randomUUID()}`,
          learnerId: input.learnerId,
          sessionId: input.sessionId,
          attemptIndex: input.attemptIndex,
          score: input.overallScore,
          day: new Date().toISOString().slice(0, 10),
        });
      }),
    );
  },
  async removeAttempt(attemptId: string, audioId: string | null) {
    return withDb("cleanupFailedAttempt", () =>
      db().transaction(async (tx) => {
        await tx.delete(speakingAttempts).where(eq(speakingAttempts.id, attemptId));
        if (audioId) await tx.delete(audioRecordings).where(eq(audioRecordings.id, audioId));
      }),
    );
  },
  async markFailed(attemptId: string) {
    await withDb("markAttemptFailed", () =>
      db()
        .update(speakingAttempts)
        .set({ status: "failed" })
        .where(eq(speakingAttempts.id, attemptId)),
    );
  },
  async markFailedIfProcessing(attemptId: string) {
    return withDb("markAttemptFailedIfProcessing", () =>
      db().transaction(async (tx) => {
        const currentRows = await tx
          .select({ audioId: speakingAttempts.audioId })
          .from(speakingAttempts)
          .where(and(eq(speakingAttempts.id, attemptId), eq(speakingAttempts.status, "processing")))
          .limit(1);
        const current = currentRows[0];
        if (!current) return false;

        let storageKey: string | undefined;
        if (current.audioId) {
          const audioRows = await tx
            .select({ storageKey: audioRecordings.storageKey })
            .from(audioRecordings)
            .where(eq(audioRecordings.id, current.audioId))
            .limit(1);
          storageKey = audioRows[0]?.storageKey;
        }

        const updated = await tx
          .update(speakingAttempts)
          .set({ status: "failed", audioId: null })
          .where(and(eq(speakingAttempts.id, attemptId), eq(speakingAttempts.status, "processing")))
          .returning({ id: speakingAttempts.id });
        if (updated.length === 0) return false;

        if (current.audioId) {
          await tx.delete(audioRecordings).where(eq(audioRecordings.id, current.audioId));
        }
        if (storageKey) {
          await tx.insert(storageCleanupJobs).values({
            id: `cln_${randomUUID()}`,
            storageKey,
            reason: "stale-attempt-audio",
            nextAttemptAt: new Date(Date.now() + FAILED_ATTEMPT_AUDIO_RETENTION_MS),
          });
        }
        return true;
      }),
    );
  },
  async removeAudioMetadata(audioId: string) {
    await withDb("cleanupFailedAudioMetadata", () =>
      db().delete(audioRecordings).where(eq(audioRecordings.id, audioId)),
    );
  },
};
