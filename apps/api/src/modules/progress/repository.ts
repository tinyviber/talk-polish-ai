import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { progressEvents, practiceSessions, savedExpressions } from "../../db/schema";
import { withDb } from "../../http/with-db";

export type ProgressSessionRow = {
  sessionId: string;
  promptId: string;
  lang: string;
  createdAt: Date;
  day: string;
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
          createdAt: progressEvents.createdAt,
          day: progressEvents.day,
          attemptIndex: progressEvents.attemptIndex,
          score: progressEvents.score,
        })
        .from(practiceSessions)
        .innerJoin(progressEvents, eq(progressEvents.sessionId, practiceSessions.id))
        .where(eq(progressEvents.learnerId, learnerId))
        .orderBy(asc(progressEvents.createdAt)),
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
