import type { Lang } from "@kotoba/contracts";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { prompts } from "../../db/schema";
import { withDb } from "../../http/with-db";

export type PromptRow = typeof prompts.$inferSelect;

export const promptRepository = {
  async list(lang?: Lang) {
    return withDb("listPrompts", () =>
      lang
        ? db().select().from(prompts).where(eq(prompts.lang, lang)).orderBy(asc(prompts.sortOrder))
        : db().select().from(prompts).orderBy(asc(prompts.sortOrder)),
    );
  },
  async findById(id: string) {
    const rows = await withDb("findPromptById", () =>
      db().select().from(prompts).where(eq(prompts.id, id)),
    );
    return rows[0];
  },
};
