import { randomUUID } from "node:crypto";
import type { Attempt, AttemptStatus, Feedback, Lang, PracticeSession } from "@kotoba/contracts";
import { asc, eq } from "drizzle-orm";
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
): Promise<PracticeSession> {
  await requireLearner(learnerId);
  const prompt = await requirePrompt(promptId);
  const inserted = await withDb("createPracticeSession", () =>
    db()
      .insert(practiceSessions)
      .values({ id: `ses_${randomUUID()}`, learnerId, promptId, lang: prompt.lang })
      .returning(),
  );
  const row = inserted[0]!;
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
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    index: attempt.attemptIndex === 2 ? 2 : 1,
    status: attempt.status as AttemptStatus,
    transcript: result?.transcript ?? null,
    feedback: (result?.feedback as Feedback | undefined) ?? null,
    durationSec: attempt.durationSec,
    mocked: attempt.mocked,
    audio: audio
      ? {
          id: audio.id,
          storageKey: audio.storageKey,
          mimeType: audio.mimeType,
          sizeBytes: audio.sizeBytes,
          durationSec: audio.durationSec,
        }
      : null,
    createdAt: attempt.createdAt.toISOString(),
  };
}
