import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attemptResults,
  practiceSessions,
  savedExpressions,
  speakingAttempts,
} from "../../db/schema";
import { withDb } from "../../http/with-db";

export type ProgressSessionRow = {
  sessionId: string;
  promptId: string;
  lang: string;
  createdAt: Date;
  attemptIndex: number | null;
  score: number | null;
};

export const progressRepository = {
  async listSessions(learnerId: string): Promise<ProgressSessionRow[]> {
    return withDb("listProgressSessions", () =>
      db()
        .select({
          sessionId: practiceSessions.id,
          promptId: practiceSessions.promptId,
          lang: practiceSessions.lang,
          createdAt: practiceSessions.createdAt,
          attemptIndex: speakingAttempts.attemptIndex,
          score: attemptResults.overallScore,
        })
        .from(practiceSessions)
        .leftJoin(speakingAttempts, eq(speakingAttempts.sessionId, practiceSessions.id))
        .leftJoin(attemptResults, eq(attemptResults.attemptId, speakingAttempts.id))
        .where(eq(practiceSessions.learnerId, learnerId))
        .orderBy(asc(practiceSessions.createdAt)),
    );
  },
  async countSaved(learnerId: string) {
    const rows = await withDb("countSavedExpressions", () =>
      db()
        .select({ id: savedExpressions.id })
        .from(savedExpressions)
        .where(eq(savedExpressions.learnerId, learnerId)),
    );
    return rows.length;
  },
};
