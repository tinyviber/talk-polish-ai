import type { Lang, Prompt } from "@kotoba/contracts";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { prompts } from "../../db/schema";
import { ApiError } from "../../http/errors";
import { withDb } from "../../http/with-db";

type Row = typeof prompts.$inferSelect;

const toPrompt = (row: Row): Prompt => ({
  id: row.id,
  lang: row.lang as Lang,
  scenario: row.scenario,
  situation: row.situation,
  question: row.question,
  ...(row.questionTranslation ? { questionTranslation: row.questionTranslation } : {}),
  hints: row.hints,
  seconds: row.seconds,
});

export async function listPrompts(lang?: Lang): Promise<Prompt[]> {
  const rows = await withDb("listPrompts", () =>
    lang
      ? db().select().from(prompts).where(eq(prompts.lang, lang)).orderBy(asc(prompts.sortOrder))
      : db().select().from(prompts).orderBy(asc(prompts.sortOrder)),
  );
  return rows.map(toPrompt);
}

export async function requirePrompt(id: string): Promise<Prompt> {
  const rows = await withDb("requirePrompt", () =>
    db().select().from(prompts).where(eq(prompts.id, id)),
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Prompt");
  return toPrompt(row);
}
