import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { installFakeIndexedDb } from "@/lib/practice/test/fakeIndexedDb";
import {
  applyRemoteStorySession,
  ensureDailyStorage,
  deleteStorySession,
  listSyncConflicts,
  listSyncMeta,
  listSyncOutbox,
  readSyncToken,
  readStorySession,
  repairStoryReviewFromSync,
  writeStorySession,
  writeSyncToken,
} from ".";
import {
  conflictConversationIdForPayload,
  conflictKey,
  createConflictCopyInTransaction,
  hashSyncPayload,
  markSyncSuccess,
  recordConflict,
  toSyncConversation,
} from "./story-sync-repository";
import type { StorySession } from "../types";
import { SYNC_META_STORE } from "./internal/database";
import { syncMetaSchema } from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";
import { __resetDailyStorageForTests } from "./testing";

let restore: () => void;

beforeAll(() => {
  restore = installFakeIndexedDb();
});

beforeEach(async () => {
  await __resetDailyStorageForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("kotoba-loop-settings");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("kotoba-daily-story-review-v2");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await __resetDailyStorageForTests();
  await ensureDailyStorage();
});

afterAll(() => restore());

describe("Daily Story sync persistence", () => {
  test("session CAS commit also durably enqueues latest aggregate", async () => {
    const first = await writeStorySession(
      "conversation-sync-test",
      {
        phase: "chatting",
        storyZh: "一个故事",
        messages: [{ id: "a1", role: "assistant", text: "Hello." }],
      },
      null,
    );
    expect(await listSyncOutbox()).toHaveLength(1);
    expect((await listSyncOutbox())[0]).toMatchObject({
      conversationId: "conversation-sync-test",
      operation: "upsert",
      localRevision: first.revision,
      payload: { conversationId: "conversation-sync-test", messages: first.messages },
    });

    await writeStorySession(
      "conversation-sync-test",
      {
        ...first,
        messages: [...first.messages, { id: "u1", role: "user", text: "I am fine." }],
      },
      first.revision,
    );
    const latest = await listSyncOutbox();
    expect(latest).toHaveLength(1);
    expect(latest[0]?.payload?.messages).toHaveLength(2);
  });

  test("delete is durable as a tombstone mutation and token stays separate", async () => {
    await writeSyncToken("a-local-test-sync-token");
    expect(await readSyncToken()).toBe("a-local-test-sync-token");
    const saved = await writeStorySession(
      "conversation-delete-test",
      { phase: "chatting", storyZh: "故事", messages: [] },
      null,
    );
    await deleteStorySession("conversation-delete-test", saved.revision);
    expect((await listSyncOutbox())[0]).toMatchObject({
      operation: "delete",
      payload: null,
      localRevision: null,
    });
  });

  test("a stale remote upsert cannot resurrect a locally deleted conversation", async () => {
    const saved = await writeStorySession(
      "conversation-anti-resurrection",
      { phase: "chatting", storyZh: "故事", messages: [] },
      null,
    );
    await deleteStorySession("conversation-anti-resurrection", saved.revision);

    const result = await applyRemoteStorySession(
      "conversation-anti-resurrection",
      { ...saved, updatedAt: new Date().toISOString() },
      2,
      null,
    );

    expect(result).toBe("skipped");
    expect(await readStorySession("conversation-anti-resurrection")).toBeNull();
    expect((await listSyncOutbox())[0]).toMatchObject({ operation: "delete" });
  });

  test("conflict copies use a stable payload id and repair idempotently", async () => {
    const copy: StorySession = {
      schemaVersion: 1,
      revision: 1,
      sessionInstanceId: "session-conflict-copy",
      updatedAt: "2026-08-15T00:00:00.000Z",
      phase: "chatting",
      storyZh: "冲突故事",
      messages: [{ id: "assistant_1", role: "assistant", text: "Hello." }],
    };
    const payload = toSyncConversation(copy, "conversation-source");
    const key = conflictKey("conversation-source", "sync_mutation_123456");
    const hash = await hashSyncPayload(payload);
    const id = await conflictConversationIdForPayload("conversation-source", payload);

    await expect(
      createConflictCopyInTransaction(key, "conversation-source", id, hash, copy),
    ).resolves.toBe("created");
    await expect(
      createConflictCopyInTransaction(key, "conversation-source", id, hash, copy),
    ).resolves.toBe("repaired");

    expect((await listSyncOutbox()).filter((item) => item.conversationId === id)).toHaveLength(1);
    expect(
      (await listSyncConflicts()).find((conflict) => conflict.conflictKey === key),
    ).toMatchObject({
      conflictConversationId: id,
      status: "open",
    });
  });

  test("a newly accepted delete resolves the matching delete conflict", async () => {
    const saved = await writeStorySession(
      "conversation-delete-conflict",
      { phase: "chatting", storyZh: "故事", messages: [] },
      null,
    );
    await deleteStorySession("conversation-delete-conflict", saved.revision);
    const item = (await listSyncOutbox()).find(
      (value) => value.conversationId === "conversation-delete-conflict",
    );
    expect(item?.operation).toBe("delete");
    if (!item) throw new Error("delete outbox missing");
    await recordConflict(
      conflictKey(item.conversationId, "older_delete_mutation"),
      item.conversationId,
      undefined,
      "delete",
    );

    await markSyncSuccess(item, 1, null);

    expect(
      (await listSyncConflicts()).filter(
        (conflict) => conflict.sourceConversationId === item.conversationId,
      ),
    ).toHaveLength(0);
  });

  test("stale review repair markers are cleared after a newer local session wins", async () => {
    const conversationId = "conversation-review-repair-stale";
    const first = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "故事", messages: [] },
      null,
    );
    const newer = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "新故事", messages: first.messages },
      first.revision,
    );
    await transaction<void>(SYNC_META_STORE, "readwrite", (tx) => {
      const request = tx.objectStore(SYNC_META_STORE).put(
        syncMetaSchema.parse({
          conversationId,
          remoteRevision: 2,
          localRevision: first.revision,
          sessionInstanceId: first.sessionInstanceId,
          reviewRepair: {
            operation: "upsert",
            remoteRevision: 2,
            sessionRevision: first.revision,
            sessionInstanceId: first.sessionInstanceId,
            review: null,
          },
          updatedAt: new Date().toISOString(),
        }),
      );
      request.onsuccess = () => setResult(tx, undefined);
    });

    await expect(
      repairStoryReviewFromSync(conversationId, (await listSyncMeta())[0]!.reviewRepair!),
    ).resolves.toBe(false);
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).not.toHaveProperty("reviewRepair");
    expect((await readStorySession(conversationId))?.revision).toBe(newer.revision);
  });
});
