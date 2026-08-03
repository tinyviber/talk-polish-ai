import { randomUUID } from "node:crypto";
import type { Expression, SavedExpression } from "@kotoba/contracts";
import { requireLearner } from "../learners/service";
import { ApiError } from "../../http/errors";
import { savedExpressionRepository, type SavedExpressionRow } from "./repository";

type Row = SavedExpressionRow;

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
  const row = await savedExpressionRepository.save({
        id: `exp_${randomUUID()}`,
        learnerId,
        expressionId: expression.id,
        lang: expression.lang,
        text: expression.text,
        reading: expression.reading ?? null,
        meaning: expression.meaning,
      });
  return toSaved(row);
}

export async function listSavedExpressions(learnerId: string): Promise<SavedExpression[]> {
  const rows = await savedExpressionRepository.list(learnerId);
  return rows.map(toSaved);
}

export async function removeSavedExpression(learnerId: string, expressionId: string) {
  const rows = await savedExpressionRepository.remove(learnerId, expressionId);
  if (rows.length === 0) throw ApiError.notFound("Saved expression");
}
