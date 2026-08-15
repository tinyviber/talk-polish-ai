import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { dailyStorySyncObjects } from "../../db/schema";
import { withDb } from "../../http/with-db";
import type { DailyStorySyncPushRequest } from "@kotoba/contracts";

export type DailyStorySyncRow = typeof dailyStorySyncObjects.$inferSelect;

export type ApplySyncResult =
  | { kind: "accepted"; idempotent: boolean; row: DailyStorySyncRow }
  | { kind: "conflict"; row: DailyStorySyncRow | null }
  | { kind: "invalid_mutation"; row: DailyStorySyncRow };

export type DailyStorySyncCursor = {
  updatedAt: string;
  conversationId: string;
};

export const dailyStorySyncRepository = {
  async list(limit: number, cursor?: DailyStorySyncCursor) {
    return withDb("listDailyStorySyncObjects", () =>
      db()
        .select()
        .from(dailyStorySyncObjects)
        .where(
          cursor
            ? or(
                gt(dailyStorySyncObjects.updatedAt, new Date(cursor.updatedAt)),
                and(
                  eq(dailyStorySyncObjects.updatedAt, new Date(cursor.updatedAt)),
                  gt(dailyStorySyncObjects.conversationId, cursor.conversationId),
                ),
              )
            : undefined,
        )
        .orderBy(asc(dailyStorySyncObjects.updatedAt), asc(dailyStorySyncObjects.conversationId))
        .limit(limit),
    );
  },

  async apply(
    conversationId: string,
    input: DailyStorySyncPushRequest,
    contentHash: string,
    mutationHash: string,
  ) {
    return withDb("applyDailyStorySyncObject", () =>
      db().transaction(async (tx): Promise<ApplySyncResult> => {
        // Advisory lock covers the absent-row case; row lock protects existing rows.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))`);
        const rows = await tx
          .select()
          .from(dailyStorySyncObjects)
          .where(eq(dailyStorySyncObjects.conversationId, conversationId))
          .for("update");
        const current = rows[0] ?? null;

        if (current?.lastMutationId === input.mutationId) {
          if (current.mutationHash !== mutationHash) {
            return { kind: "invalid_mutation", row: current };
          }
          return { kind: "accepted", idempotent: true, row: current };
        }

        const expectedMatches = current
          ? input.expectedRemoteRevision === current.remoteRevision
          : input.expectedRemoteRevision === null;
        if (!expectedMatches) return { kind: "conflict", row: current };

        const values = {
          conversationId,
          remoteRevision: (current?.remoteRevision ?? 0) + 1,
          clientRevision: input.clientRevision,
          sessionInstanceId: input.object?.sessionInstanceId ?? input.sessionInstanceId ?? null,
          contentHash,
          mutationHash,
          deleted: input.object === null,
          payload: input.object,
          lastMutationId: input.mutationId,
          updatedAt: new Date(),
        };
        const updated = current
          ? await tx
              .update(dailyStorySyncObjects)
              .set(values)
              .where(eq(dailyStorySyncObjects.conversationId, conversationId))
              .returning()
          : await tx.insert(dailyStorySyncObjects).values(values).returning();
        return { kind: "accepted", idempotent: false, row: updated[0]! };
      }),
    );
  },
};

export function rowToRemoteObject(row: DailyStorySyncRow) {
  return {
    conversationId: row.conversationId,
    remoteRevision: row.remoteRevision,
    clientRevision: row.clientRevision,
    ...(row.sessionInstanceId ? { sessionInstanceId: row.sessionInstanceId } : {}),
    contentHash: row.contentHash,
    deleted: row.deleted,
    updatedAt: row.updatedAt.toISOString(),
    payload: row.payload,
  };
}

export function encodeSyncCursor(row: Pick<DailyStorySyncRow, "updatedAt" | "conversationId">) {
  return Buffer.from(
    JSON.stringify({ updatedAt: row.updatedAt.toISOString(), conversationId: row.conversationId }),
    "utf8",
  ).toString("base64url");
}

export function decodeSyncCursor(value: string): DailyStorySyncCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid sync cursor.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { updatedAt?: unknown }).updatedAt !== "string" ||
    typeof (parsed as { conversationId?: unknown }).conversationId !== "string" ||
    Number.isNaN(Date.parse((parsed as { updatedAt: string }).updatedAt))
  ) {
    throw new Error("Invalid sync cursor.");
  }
  return parsed as DailyStorySyncCursor;
}
