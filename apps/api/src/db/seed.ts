import { PROMPTS } from "@kotoba/contracts";
import { sql } from "drizzle-orm";
import { closeDatabase, db } from "./client";
import { prompts } from "./schema";

/** Idempotent seed of the deterministic practice prompts. */
export async function seed() {
  const rows = PROMPTS.map((p, i) => ({
    id: p.id,
    lang: p.lang,
    scenario: p.scenario,
    situation: p.situation,
    question: p.question,
    questionTranslation: p.questionTranslation ?? null,
    hints: p.hints,
    seconds: p.seconds,
    sortOrder: i,
  }));

  await db()
    .insert(prompts)
    .values(rows)
    .onConflictDoUpdate({
      target: prompts.id,
      set: {
        lang: sql`excluded.lang`,
        scenario: sql`excluded.scenario`,
        situation: sql`excluded.situation`,
        question: sql`excluded.question`,
        questionTranslation: sql`excluded.question_translation`,
        hints: sql`excluded.hints`,
        seconds: sql`excluded.seconds`,
        sortOrder: sql`excluded.sort_order`,
      },
    });

  console.log(`seeded ${rows.length} prompts`);
}

if (import.meta.main) {
  seed()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("seed failed:", error instanceof Error ? error.message : error);
      await closeDatabase();
      process.exit(1);
    });
}
