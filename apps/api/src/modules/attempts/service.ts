import { randomUUID } from "node:crypto";
import {
  MAX_AUDIO_BYTES,
  SUPPORTED_AUDIO_MIME_TYPES,
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

export function assertSupportedAudio(audio: UploadedAudio) {
  const mime = audio.mimeType.split(";")[0]!.trim().toLowerCase();
  if (!(SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(mime)) {
    throw ApiError.unsupportedMedia(`Audio format "${mime}" is not supported.`, [
      `Supported formats: ${SUPPORTED_AUDIO_MIME_TYPES.join(", ")}`,
    ]);
  }
  if (audio.buffer.byteLength === 0) throw ApiError.missingAudio("The uploaded recording is empty.");
  if (audio.buffer.byteLength > MAX_AUDIO_BYTES) {
    throw ApiError.tooLarge(
      `Recording is larger than ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))} MB.`,
    );
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
  fields: CreateAttemptFields,
  audio: UploadedAudio | null,
): Promise<Attempt> {
  const sessionRows = await withDb("loadSessionForAttempt", () =>
    db().select().from(practiceSessions).where(eq(practiceSessions.id, sessionId)),
  );
  const session = sessionRows[0];
  if (!session) throw ApiError.notFound("Practice session");
  if (session.learnerId !== fields.learnerId) {
    throw ApiError.notFound("Practice session for this learner");
  }
  if (!audio && !fields.mocked) throw ApiError.missingAudio();

  const prompt = await requirePrompt(session.promptId);
  const attemptIndex = fields.attemptIndex === 2 ? 2 : 1;
  const attemptId = `att_${randomUUID()}`;
  const { storage, transcription, assessment } = providers();

  let audioId: string | null = null;
  if (audio) {
    const mime = assertSupportedAudio(audio);
    const ext = EXTENSIONS[mime] ?? "bin";
    let storageKey: string;
    try {
      const stored = await storage.put({
        key: `recordings/${session.learnerId}/${attemptId}.${ext}`,
        body: audio.buffer,
        contentType: mime,
      });
      storageKey = stored.storageKey;
    } catch (error) {
      console.error("[storage] put failed:", error instanceof StorageError ? error.message : error);
      throw ApiError.storage();
    }

    audioId = `aud_${randomUUID()}`;
    await withDb("insertAudioRecording", () =>
      db().insert(audioRecordings).values({
        id: audioId!,
        storageKey,
        mimeType: mime,
        sizeBytes: audio.buffer.byteLength,
        durationSec: fields.durationSec,
      }),
    );
  }

  await withDb("insertAttempt", () =>
    db().insert(speakingAttempts).values({
      id: attemptId,
      sessionId,
      learnerId: session.learnerId,
      attemptIndex,
      status: "processing",
      durationSec: fields.durationSec,
      mocked: audio === null,
      audioId,
    }),
  );

  try {
    const audioRef = audio
      ? { storageKey: `pending:${attemptId}`, mimeType: audio.mimeType, bytes: audio.buffer.byteLength }
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

    await withDb("insertAttemptResult", async () => {
      await db().insert(attemptResults).values({
        attemptId,
        transcript: transcript.text,
        transcriptionProvider: transcript.provider,
        assessmentProvider: assessed.provider,
        overallScore: assessed.feedback.overall,
        feedback: assessed.feedback,
      });
      await db().update(speakingAttempts).set({ status: "ready" }).where(eq(speakingAttempts.id, attemptId));
      await db().insert(progressEvents).values({
        id: `prg_${randomUUID()}`,
        learnerId: session.learnerId,
        sessionId,
        attemptIndex,
        score: assessed.feedback.overall,
        day: new Date().toISOString().slice(0, 10),
      });
    });
  } catch (error) {
    await withDb("markAttemptFailed", () =>
      db().update(speakingAttempts).set({ status: "failed" }).where(eq(speakingAttempts.id, attemptId)),
    ).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    console.error("[providers] attempt processing failed:", error instanceof Error ? error.message : error);
    throw ApiError.processingUnavailable();
  }

  return getAttempt(attemptId);
}
