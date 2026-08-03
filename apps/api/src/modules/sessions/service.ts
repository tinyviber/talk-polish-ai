import { randomUUID } from "node:crypto";
import {
  feedbackSchema,
  transcriptionMetadataSchema,
  type Attempt,
  type AttemptStatus,
  type Lang,
  type PracticeSession,
} from "@kotoba/contracts";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attemptResults,
  audioRecordings,
  practiceSessions,
  speakingAttempts,
} from "../../db/schema";
import { ApiError } from "../../http/errors";
import { withDb } from "../../http/with-db";
import { requirePrompt } from "../prompts/service";
import { requireLearner } from "../learners/service";

export async function createPracticeSession(
  learnerId: string,
  promptId: string,
  clientSessionId?: string,
): Promise<PracticeSession> {
  await requireLearner(learnerId);
  const prompt = await requirePrompt(promptId);
  // Offline devices replay the same clientSessionId; return the existing
  // session instead of creating a duplicate for the same recordings.
  if (clientSessionId) {
    const existing = await withDb("findPracticeSessionByClientId", () =>
      db()
        .select()
        .from(practiceSessions)
        .where(
          and(
            eq(practiceSessions.learnerId, learnerId),
            eq(practiceSessions.clientSessionId, clientSessionId),
          ),
        )
        .limit(1),
    );
    const found = existing[0];
    if (found) {
      if (found.promptId !== promptId) {
        throw ApiError.conflict("This offline session id already belongs to another prompt.");
      }
      return {
        id: found.id,
        learnerId: found.learnerId,
        promptId: found.promptId,
        lang: found.lang as Lang,
        createdAt: found.createdAt.toISOString(),
        attempts: await listAttempts(found.id),
      };
    }
  }
  const inserted = await withDb("createPracticeSession", () =>
    db()
      .insert(practiceSessions)
      .values({
        id: `ses_${randomUUID()}`,
        learnerId,
        promptId,
        lang: prompt.lang,
        ...(clientSessionId ? { clientSessionId } : {}),
      })
      .onConflictDoNothing()
      .returning(),
  );
  const row = inserted[0];
  // A concurrent replay of the same key won the insert race; read it back.
  if (!row && clientSessionId) return createPracticeSession(learnerId, promptId, clientSessionId);
  if (!row) throw ApiError.internal("The practice session could not be created.");
  return {
    id: row.id,
    learnerId: row.learnerId,
    promptId: row.promptId,
    lang: row.lang as Lang,
    createdAt: row.createdAt.toISOString(),
    attempts: [],
  };
}

export async function getPracticeSession(id: string, learnerId: string): Promise<PracticeSession> {
  const rows = await withDb("getPracticeSession", () =>
    db().select().from(practiceSessions).where(eq(practiceSessions.id, id)),
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Practice session");
  if (row.learnerId !== learnerId) throw ApiError.notFound("Practice session");
  return {
    id: row.id,
    learnerId: row.learnerId,
    promptId: row.promptId,
    lang: row.lang as Lang,
    createdAt: row.createdAt.toISOString(),
    attempts: await listAttempts(row.id),
  };
}

export async function listAttempts(sessionId: string): Promise<Attempt[]> {
  const rows = await withDb("listAttempts", () =>
    db()
      .select({
        attempt: speakingAttempts,
        result: attemptResults,
        audio: audioRecordings,
      })
      .from(speakingAttempts)
      .leftJoin(attemptResults, eq(attemptResults.attemptId, speakingAttempts.id))
      .leftJoin(audioRecordings, eq(audioRecordings.id, speakingAttempts.audioId))
      .where(eq(speakingAttempts.sessionId, sessionId))
      .orderBy(asc(speakingAttempts.attemptIndex)),
  );
  return rows.map((r) => composeAttempt(r.attempt, r.result, r.audio));
}

export async function getAttempt(id: string, learnerId?: string): Promise<Attempt> {
  const rows = await withDb("getAttempt", () =>
    db()
      .select({ attempt: speakingAttempts, result: attemptResults, audio: audioRecordings })
      .from(speakingAttempts)
      .leftJoin(attemptResults, eq(attemptResults.attemptId, speakingAttempts.id))
      .leftJoin(audioRecordings, eq(audioRecordings.id, speakingAttempts.audioId))
      .where(eq(speakingAttempts.id, id)),
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Attempt");
  if (learnerId && row.attempt.learnerId !== learnerId) throw ApiError.notFound("Attempt");
  return composeAttempt(row.attempt, row.result, row.audio);
}

export function composeAttempt(
  attempt: typeof speakingAttempts.$inferSelect,
  result: typeof attemptResults.$inferSelect | null,
  audio: typeof audioRecordings.$inferSelect | null,
): Attempt {
  let feedback = null;
  if (result?.feedback !== undefined) {
    const parsed = feedbackSchema.safeParse(result.feedback);
    if (!parsed.success) throw ApiError.internal("Stored attempt feedback is invalid.");
    feedback = parsed.data;
  }
  let transcription;
  if (result?.transcription !== null && result?.transcription !== undefined) {
    const parsed = transcriptionMetadataSchema.safeParse(result.transcription);
    if (!parsed.success) throw ApiError.internal("Stored transcription metadata is invalid.");
    transcription = parsed.data;
  }
  return {
    id: attempt.id,
    ...(attempt.clientAttemptId ? { clientAttemptId: attempt.clientAttemptId } : {}),
    sessionId: attempt.sessionId,
    index: attempt.attemptIndex === 2 ? 2 : 1,
    status: attempt.status as AttemptStatus,
    transcript: result?.transcript ?? null,
    ...(transcription ? { transcription } : {}),
    feedback,
    durationSec: attempt.durationSec,
    mocked: attempt.mocked,
    audio: audio
      ? {
          id: audio.id,
          mimeType: audio.mimeType,
          sizeBytes: audio.sizeBytes,
          durationSec: audio.durationSec,
          playbackUrl: `/api/audio/recordings/${audio.id}`,
        }
      : null,
    createdAt: attempt.createdAt.toISOString(),
  };
}
