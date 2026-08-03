import { randomUUID } from "node:crypto";
import type { Lang } from "@kotoba/contracts";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { learners } from "../../db/schema";
import { withDb } from "../../http/with-db";

export type LearnerRow = typeof learners.$inferSelect;

export const learnerRepository = {
  async findById(id: string) {
    const rows = await withDb("findLearnerById", () =>
      db().select().from(learners).where(eq(learners.id, id)),
    );
    return rows[0];
  },
  /** Atomic device upsert; concurrent bootstrap requests return one learner. */
  async upsertAnonymous(deviceId: string, lang: Lang | null): Promise<LearnerRow> {
    const rows = await withDb("upsertAnonymousLearner", () =>
      db()
        .insert(learners)
        .values({ id: `lnr_${randomUUID()}`, deviceId, lang })
        .onConflictDoUpdate({
          target: learners.deviceId,
          set: { lang: lang ? lang : sql`${learners.lang}` },
        })
        .returning(),
    );
    return rows[0]!;
  },
};
