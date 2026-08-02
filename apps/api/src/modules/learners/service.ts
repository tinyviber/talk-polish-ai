import { randomUUID } from "node:crypto";
import type { Learner } from "@kotoba/contracts";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { learners } from "../../db/schema";
import { withDb } from "../../http/with-db";
import { ApiError } from "../../http/errors";

type Row = typeof learners.$inferSelect;

const toLearner = (row: Row): Learner => ({
  id: row.id,
  deviceId: row.deviceId,
  lang: (row.lang as Learner["lang"]) ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** Create or resume an anonymous, device-scoped learner profile. */
export async function upsertAnonymousLearner(
  deviceId: string,
  lang: Learner["lang"],
): Promise<Learner> {
  return withDb("upsertAnonymousLearner", async () => {
    const existing = await db().select().from(learners).where(eq(learners.deviceId, deviceId));
    const found = existing[0];
    if (found) {
      if (lang && lang !== found.lang) {
        const updated = await db()
          .update(learners)
          .set({ lang })
          .where(eq(learners.id, found.id))
          .returning();
        return toLearner(updated[0]!);
      }
      return toLearner(found);
    }
    const inserted = await db()
      .insert(learners)
      .values({ id: `lnr_${randomUUID()}`, deviceId, lang: lang ?? null })
      .returning();
    return toLearner(inserted[0]!);
  });
}

export async function requireLearner(learnerId: string): Promise<Learner> {
  const rows = await withDb("requireLearner", () =>
    db().select().from(learners).where(eq(learners.id, learnerId)),
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Learner");
  return toLearner(row);
}
