import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { savedExpressions } from "../../db/schema";
import { withDb } from "../../http/with-db";

export type SavedExpressionRow = typeof savedExpressions.$inferSelect;

export const savedExpressionRepository = {
  async save(input: typeof savedExpressions.$inferInsert) {
    const rows = await withDb("saveExpression", () =>
      db()
        .insert(savedExpressions)
        .values(input)
        .onConflictDoUpdate({
          target: [savedExpressions.learnerId, savedExpressions.expressionId],
          set: {
            lang: input.lang,
            text: input.text,
            reading: input.reading,
            meaning: input.meaning,
          },
        })
        .returning(),
    );
    return rows[0]!;
  },
  async list(learnerId: string) {
    return withDb("listSavedExpressions", () =>
      db()
        .select()
        .from(savedExpressions)
        .where(eq(savedExpressions.learnerId, learnerId))
        .orderBy(desc(savedExpressions.savedAt)),
    );
  },
  async remove(learnerId: string, expressionId: string) {
    return withDb("removeSavedExpression", () =>
      db()
        .delete(savedExpressions)
        .where(
          and(
            eq(savedExpressions.learnerId, learnerId),
            eq(savedExpressions.expressionId, expressionId),
          ),
        )
        .returning(),
    );
  },
};
