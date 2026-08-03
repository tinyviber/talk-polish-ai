import { randomUUID } from "node:crypto";
import {
  MAX_AUDIO_BYTES,
  SUPPORTED_AUDIO_MIME_TYPES,
  feedbackSchema,
  transcriptionMetadataSchema,
  type Attempt,
  type CreateAttemptFields,
} from "@kotoba/contracts";
import { ApiError } from "../../http/errors";
import { providers } from "../../providers";
import { StorageError } from "../../providers/storage";
import { getAttempt } from "../sessions/service";
import { requirePrompt } from "../prompts/service";
import { enforceProviderRateLimit } from "../providers/rate-limit";
import { removeOrQueueStorage } from "../../db/storage-cleanup";
import { attemptRepository } from "./repository";

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
  clientIp?: string,
): Promise<Attempt> {
  const session = await attemptRepository.findSession(sessionId);
  if (!session) throw ApiError.notFound("Practice session");
  if (session.learnerId !== learnerId) {
    throw ApiError.notFound("Practice session for this learner");
  }
  // Demo mode is client-only. Never let an API caller fabricate a successful
  // attempt by setting the legacy `mocked` form field without an audio Blob.
  if (!audio) throw ApiError.missingAudio();

  const prompt = await requirePrompt(session.promptId);
  const attemptIndex = fields.attemptIndex === 2 ? 2 : 1;
  const attemptId = `att_${randomUUID()}`;
  const clientAttemptId = fields.clientAttemptId;
  if (clientAttemptId) {
    const existing = await attemptRepository.findByClientId(learnerId, clientAttemptId);
    if (existing && (existing.sessionId !== sessionId || existing.attemptIndex !== attemptIndex)) {
      throw ApiError.conflict("clientAttemptId is already used for another attempt.");
    }
    // Network retries return the same processing/ready/failed record. A failed
    // record is intentionally reclaimed below so an explicit retry can reuse
    // the same durable client key without creating duplicates.
    const staleProcessing =
      existing?.status === "processing" &&
      Date.now() - existing.createdAt.getTime() >= STALE_PROCESSING_MS;
    if (existing && existing.status !== "failed" && !staleProcessing) {
      return getAttempt(existing.id, learnerId);
    }
  }
  const {
    storage,
    transcription: transcriptionProvider,
    assessment: assessmentProvider,
  } = providers();
  enforceProviderRateLimit(learnerId, "attempt", clientIp);

  let audioId: string | null = null;
  let storageKey: string | null = null;
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
    const inserted = await attemptRepository.insertProcessing({
      attemptId,
      sessionId,
      learnerId,
      attemptIndex,
      clientAttemptId: clientAttemptId ?? null,
      durationSec: fields.durationSec,
      mocked: false,
      storageKey,
      audio: audio ? { buffer: audio.buffer, mimeType: audio.mimeType } : null,
    });
    audioId = inserted.audioId;
    for (const reclaimedKey of inserted.reclaimedStorageKeys) {
      await removeOrQueueStorage(storage, reclaimedKey, "reclaimed-attempt");
    }
  } catch (error) {
    if (clientAttemptId) {
      try {
        const raced = await attemptRepository.findRaced(learnerId, clientAttemptId);
        if (raced) {
          if (raced.sessionId !== sessionId || raced.attemptIndex !== attemptIndex) {
            if (storageKey) await removeOrQueueStorage(storage, storageKey, "idempotent-mismatch");
            throw ApiError.conflict("clientAttemptId is already used for another attempt.");
          }
          if (storageKey) await removeOrQueueStorage(storage, storageKey, "idempotent-retry");
          return getAttempt(raced.id, learnerId);
        }
      } catch (raceError) {
        if (raceError instanceof ApiError) throw raceError;
      }
    }
    if (storageKey) await removeOrQueueStorage(storage, storageKey, "attempt-db-failed");
    throw error;
  }

  try {
    const audioRef = audio
      ? { storageKey: storageKey!, mimeType: audio.mimeType, bytes: audio.buffer.byteLength }
      : null;
    const transcript = await transcriptionProvider.transcribe({
      lang: prompt.lang,
      promptId: prompt.id,
      attemptIndex,
      durationSec: fields.durationSec,
      audio: audioRef,
    });
    const assessed = await assessmentProvider.assess({
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

    const transcription =
      transcript.transcription === undefined || transcript.transcription === null
        ? null
        : transcriptionMetadataSchema.safeParse(transcript.transcription);
    if (transcription && !transcription.success) {
      throw ApiError.processingUnavailable("Speech transcription returned invalid metadata.");
    }
    await attemptRepository.persistResult({
      attemptId,
      learnerId,
      sessionId,
      attemptIndex,
      transcript: transcript.text,
      transcriptionProvider: transcript.provider,
      transcription: transcription ? transcription.data : null,
      assessmentProvider: assessed.provider,
      overallScore: feedback.overall,
      feedback,
    });
  } catch (error) {
    try {
      await attemptRepository.removeAttempt(attemptId, audioId);
    } catch (cleanupError) {
      // If the delete cannot run, a failed marker makes the unique attempt slot
      // reclaimable on the next request once PostgreSQL is back.
      console.error(
        "[db] failed-attempt delete failed; marking recoverable:",
        cleanupError instanceof Error ? cleanupError.message : cleanupError,
      );
      try {
        await attemptRepository.markFailed(attemptId);
        if (audioId) {
          await attemptRepository.removeAudioMetadata(audioId).catch((metadataError) => {
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
    if (storageKey) await removeOrQueueStorage(storage, storageKey, "attempt-processing-failed");
    if (error instanceof ApiError) throw error;
    console.error(
      "[providers] attempt processing failed:",
      error instanceof Error ? error.message : error,
    );
    throw ApiError.processingUnavailable();
  }

  return getAttempt(attemptId, learnerId);
}
