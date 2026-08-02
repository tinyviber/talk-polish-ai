import { randomUUID } from "node:crypto";
import type { Expression, SavedExpression } from "@kotoba/contracts";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { savedExpressions } from "../../db/schema";
import { withDb } from "../../http/with-db";
import { requireLearner } from "../learners/service";
import { ApiError } from "../../http/errors";

type Row = typeof savedExpressions.$inferSelect;

const toSaved = (row: Row): SavedExpression => ({
  id: row.expressionId,
  lang: row.lang as SavedExpression["lang"],
  text: row.text,
  ...(row.reading ? { reading: row.reading } : {}),
  meaning: row.meaning,
  savedAt: row.savedAt.getTime(),
});

export async function saveExpression(
  learnerId: string,
  expression: Expression,
): Promise<SavedExpression> {
  await requireLearner(learnerId);
  const rows = await withDb("saveExpression", () =>
    db()
      .insert(savedExpressions)
      .values({
        id: `exp_${randomUUID()}`,
        learnerId,
        expressionId: expression.id,
        lang: expression.lang,
        text: expression.text,
        reading: expression.reading ?? null,
        meaning: expression.meaning,
      })
      .onConflictDoUpdate({
        target: [savedExpressions.learnerId, savedExpressions.expressionId],
        set: { meaning: expression.meaning, text: expression.text },
      })
      .returning(),
  );
  return toSaved(rows[0]!);
}

export async function listSavedExpressions(learnerId: string): Promise<SavedExpression[]> {
  const rows = await withDb("listSavedExpressions", () =>
    db()
      .select()
      .from(savedExpressions)
      .where(eq(savedExpressions.learnerId, learnerId))
      .orderBy(desc(savedExpressions.savedAt)),
  );
  return rows.map(toSaved);
}

export async function removeSavedExpression(learnerId: string, expressionId: string) {
  const rows = await withDb("removeSavedExpression", () =>
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
  if (rows.length === 0) throw ApiError.notFound("Saved expression");
}
