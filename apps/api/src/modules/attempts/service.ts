import { randomUUID } from "node:crypto";
import {
  MAX_AUDIO_BYTES,
  SUPPORTED_AUDIO_MIME_TYPES,
  feedbackSchema,
  type Attempt,
  type CreateAttemptFields,
} from "@kotoba/contracts";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attemptResults,
  audioRecordings,
  practiceSessions,
  progressEvents,
  speakingAttempts,
} from "../../db/schema";
import { ApiError } from "../../http/errors";
import { withDb } from "../../http/with-db";
import { providers } from "../../providers";
import { StorageError } from "../../providers/storage";
import { getAttempt } from "../sessions/service";
import { requirePrompt } from "../prompts/service";

export type UploadedAudio = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
};

/** A synchronous mock pipeline should never remain processing for this long. */
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export function assertSupportedAudio(audio: UploadedAudio, maxBytes = MAX_AUDIO_BYTES) {
  const mime = audio.mimeType.split(";")[0]!.trim().toLowerCase();
  if (!(SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(mime)) {
    throw ApiError.unsupportedMedia(`Audio format "${mime}" is not supported.`, [
      `Supported formats: ${SUPPORTED_AUDIO_MIME_TYPES.join(", ")}`,
    ]);
  }
  if (audio.buffer.byteLength === 0)
    throw ApiError.missingAudio("The uploaded recording is empty.");
  if (audio.buffer.byteLength > maxBytes) {
    throw ApiError.tooLarge(`Recording is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  }
  return mime;
}

/**
 * Full attempt pipeline: store audio -> transcribe -> assess -> persist.
 * Processing is synchronous today; the attempt row still carries a status so a
 * queued implementation can flip to `processing` + polling without API changes.
 */
export async function createAttempt(
  sessionId: string,
  learnerId: string,
  fields: CreateAttemptFields,
  audio: UploadedAudio | null,
): Promise<Attempt> {
  const sessionRows = await withDb("loadSessionForAttempt", () =>
    db().select().from(practiceSessions).where(eq(practiceSessions.id, sessionId)),
  );
  const session = sessionRows[0];
  if (!session) throw ApiError.notFound("Practice session");
  if (session.learnerId !== learnerId) {
    throw ApiError.notFound("Practice session for this learner");
  }
  if (!audio && !fields.mocked) throw ApiError.missingAudio();

  const prompt = await requirePrompt(session.promptId);
  const attemptIndex = fields.attemptIndex === 2 ? 2 : 1;
  const attemptId = `att_${randomUUID()}`;
  const { storage, transcription, assessment } = providers();

  let audioId: string | null = null;
  let storageKey: string | null = null;
  const reclaimedStorageKeys: string[] = [];
  if (audio) {
    const mime = assertSupportedAudio(audio);
    const ext = EXTENSIONS[mime] ?? "bin";
    try {
      const stored = await storage.put({
        key: `recordings/${learnerId}/${attemptId}.${ext}`,
        body: audio.buffer,
        contentType: mime,
      });
      storageKey = stored.storageKey;
    } catch (error) {
      console.error("[storage] put failed:", error instanceof StorageError ? error.message : error);
      throw ApiError.storage();
    }
  }

  try {
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
          .where(eq(speakingAttempts.sessionId, sessionId));
        const sameIndex = existing.find((row) => row.attemptIndex === attemptIndex);
        if (attemptIndex === 2) {
          const firstAttempt = existing.find(
            (row) => row.attemptIndex === 1 && row.status === "ready",
          );
          if (!firstAttempt) {
            throw ApiError.conflict("Attempt 1 must be ready before recording attempt 2.");
          }
        }
        if (sameIndex) {
          const staleProcessing =
            sameIndex.status === "processing" &&
            Date.now() - sameIndex.createdAt.getTime() >= STALE_PROCESSING_MS;
          const recoverable = sameIndex.status === "failed" || staleProcessing;
          if (!recoverable) {
            throw ApiError.conflict(`Attempt ${attemptIndex} already exists for this session.`);
          }

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

        if (storageKey && audio) {
          audioId = `aud_${randomUUID()}`;
          await tx.insert(audioRecordings).values({
            id: audioId,
            storageKey,
            mimeType: audio.mimeType.split(";")[0]!.trim().toLowerCase(),
            sizeBytes: audio.buffer.byteLength,
            durationSec: fields.durationSec,
          });
        }
        await tx.insert(speakingAttempts).values({
          id: attemptId,
          sessionId,
          learnerId,
          attemptIndex,
          status: "processing",
          durationSec: fields.durationSec,
          mocked: audio === null,
          audioId,
        });
      }),
    );
  } catch (error) {
    if (storageKey) await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }

  for (const reclaimedKey of reclaimedStorageKeys) {
    await storage.remove(reclaimedKey).catch((error) => {
      console.error("[storage] reclaimed audio cleanup failed:", error);
    });
  }

  try {
    const audioRef = audio
      ? { storageKey: storageKey!, mimeType: audio.mimeType, bytes: audio.buffer.byteLength }
      : null;
    const transcript = await transcription.transcribe({
      lang: prompt.lang,
      promptId: prompt.id,
      attemptIndex,
      durationSec: fields.durationSec,
      audio: audioRef,
    });
    const assessed = await assessment.assess({
      transcript: transcript.text,
      prompt,
      lang: prompt.lang,
      attemptIndex,
      durationSec: fields.durationSec,
    });
    let feedback;
    try {
      feedback = feedbackSchema.parse(assessed.feedback);
    } catch (error) {
      console.error(
        "[providers] assessment returned invalid feedback:",
        error instanceof Error ? error.message : error,
      );
      throw ApiError.processingUnavailable("Speech assessment returned invalid feedback.");
    }

    await withDb("persistAttemptResult", () =>
      db().transaction(async (tx) => {
        await tx.insert(attemptResults).values({
          attemptId,
          transcript: transcript.text,
          transcriptionProvider: transcript.provider,
          assessmentProvider: assessed.provider,
          overallScore: feedback.overall,
          feedback,
        });
        await tx
          .update(speakingAttempts)
          .set({ status: "ready" })
          .where(eq(speakingAttempts.id, attemptId));
        await tx.insert(progressEvents).values({
          id: `prg_${randomUUID()}`,
          learnerId,
          sessionId,
          attemptIndex,
          score: feedback.overall,
          day: new Date().toISOString().slice(0, 10),
        });
      }),
    );
  } catch (error) {
    try {
      await withDb("cleanupFailedAttempt", () =>
        db().transaction(async (tx) => {
          await tx.delete(speakingAttempts).where(eq(speakingAttempts.id, attemptId));
          if (audioId) await tx.delete(audioRecordings).where(eq(audioRecordings.id, audioId));
        }),
      );
    } catch (cleanupError) {
      // If the delete cannot run, a failed marker makes the unique attempt slot
      // reclaimable on the next request once PostgreSQL is back.
      console.error(
        "[db] failed-attempt delete failed; marking recoverable:",
        cleanupError instanceof Error ? cleanupError.message : cleanupError,
      );
      try {
        await withDb("markAttemptFailed", () =>
          db()
            .update(speakingAttempts)
            .set({ status: "failed", audioId: null })
            .where(eq(speakingAttempts.id, attemptId)),
        );
        if (audioId) {
          await withDb("cleanupFailedAudioMetadata", () =>
            db().delete(audioRecordings).where(eq(audioRecordings.id, audioId!)),
          ).catch((metadataError) => {
            console.error(
              "[db] failed-audio metadata cleanup deferred:",
              metadataError instanceof Error ? metadataError.message : metadataError,
            );
          });
        }
      } catch (markError) {
        console.error(
          "[db] failed-attempt marker failed; stale recovery will be used:",
          markError instanceof Error ? markError.message : markError,
        );
      }
    }
    if (storageKey) await storage.remove(storageKey).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    console.error(
      "[providers] attempt processing failed:",
      error instanceof Error ? error.message : error,
    );
    throw ApiError.processingUnavailable();
  }

  return getAttempt(attemptId, learnerId);
}
