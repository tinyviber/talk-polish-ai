import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attemptResults,
  audioRecordings,
  practiceSessions,
  speakingAttempts,
} from "../../db/schema";
import { withDb } from "../../http/with-db";

export type SessionRow = typeof practiceSessions.$inferSelect;
export type AttemptRow = typeof speakingAttempts.$inferSelect;
export type AttemptResultRow = typeof attemptResults.$inferSelect;
export type AudioRow = typeof audioRecordings.$inferSelect;
export type AttemptJoinRow = {
  attempt: AttemptRow;
  result: AttemptResultRow | null;
  audio: AudioRow | null;
};

export const sessionRepository = {
  async findByClientId(learnerId: string, clientSessionId: string) {
    const rows = await withDb("findPracticeSessionByClientId", () =>
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
    return rows[0];
  },
  async insert(input: {
    id: string;
    learnerId: string;
    promptId: string;
    lang: string;
    clientSessionId?: string;
  }) {
    const rows = await withDb("createPracticeSession", () =>
      db().insert(practiceSessions).values(input).onConflictDoNothing().returning(),
    );
    return rows[0];
  },
  async findById(id: string) {
    const rows = await withDb("getPracticeSession", () =>
      db().select().from(practiceSessions).where(eq(practiceSessions.id, id)),
    );
    return rows[0];
  },
  async listAttempts(sessionId: string): Promise<AttemptJoinRow[]> {
    return withDb("listAttempts", () =>
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
  },
  async findAttempt(id: string): Promise<AttemptJoinRow | undefined> {
    const rows = await withDb("getAttempt", () =>
      db()
        .select({ attempt: speakingAttempts, result: attemptResults, audio: audioRecordings })
        .from(speakingAttempts)
        .leftJoin(attemptResults, eq(attemptResults.attemptId, speakingAttempts.id))
        .leftJoin(audioRecordings, eq(audioRecordings.id, speakingAttempts.audioId))
        .where(eq(speakingAttempts.id, id)),
    );
    return rows[0];
  },
};
