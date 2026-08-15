import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  deferNextFakeIndexedDbTransaction,
  installFakeIndexedDb,
  runAfterNextFakeSessionStoreGetAll,
} from "@/lib/practice/test/fakeIndexedDb";
import {
  applyRemoteStoryDeletion,
  applyRemoteStorySession,
  deleteDailyStoryReview,
  ensureDailyStorage,
  deleteStorySession,
  listSyncConflicts,
  listSyncMeta,
  listSyncOutbox,
  listStorySessions,
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
import { getStorySyncStatus, runDailyStorySync } from "../sync/worker";
import type { DailyReview, StorySession } from "../types";
import { REVIEW_STORE, SYNC_META_STORE } from "./internal/database";
import { syncMetaSchema } from "./internal/schemas";
import { reviewTransaction, setResult, transaction } from "./internal/transaction";
import { __resetDailyStorageForTests } from "./testing";

let restore: () => void;

async function putReviewRepairMarker(
  conversationId: string,
  sessionRevision: number,
  sessionInstanceId: string,
  review: DailyReview | null,
) {
  await transaction<void>(SYNC_META_STORE, "readwrite", (tx) => {
    const request = tx.objectStore(SYNC_META_STORE).put(
      syncMetaSchema.parse({
        conversationId,
        remoteRevision: 2,
        localRevision: sessionRevision,
        sessionInstanceId,
        reviewRepair: {
          operation: "upsert",
          remoteRevision: 2,
          sessionRevision,
          sessionInstanceId,
          review,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    request.onsuccess = () => setResult(tx, undefined);
  });
}

async function putMalformedReviewSidecar(conversationId: string) {
  await reviewTransaction<void>("readwrite", (tx) => {
    const request = tx.objectStore(REVIEW_STORE).put({
      conversationId,
      score: "not-a-score",
      comment: null,
      rubric: null,
    });
    request.onsuccess = () => setResult(tx, undefined);
  });
}

async function seedPendingReviewRepair(conversationId: string) {
  const session = await writeStorySession(
    conversationId,
    {
      phase: "review",
      storyZh: "需要恢复的故事",
      messages: [],
      review: {
        score: 92,
        comment: "本地修复",
        overallFeedback: "整体清晰。",
        rubric: null,
        suggestions: [],
      },
    },
    null,
  );
  await deleteDailyStoryReview(conversationId, session.revision, session.sessionInstanceId);
  await putReviewRepairMarker(conversationId, session.revision, session.sessionInstanceId!, {
    score: 92,
    comment: "本地修复",
    overallFeedback: "整体清晰。",
    rubric: null,
    suggestions: [],
  });
  return session;
}

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

  test("local writes journal the complete review before the sidecar mutation", async () => {
    const primaryGate = deferNextFakeIndexedDbTransaction();
    const write = writeStorySession(
      "conversation-local-review-journal",
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: {
          score: 92,
          comment: "完整评分",
          overallFeedback: "整体清晰。",
          rubric: null,
          suggestions: [],
        },
      },
      null,
    );
    await primaryGate.started;
    primaryGate.release();

    const sidecarGate = deferNextFakeIndexedDbTransaction();
    await sidecarGate.started;
    expect(await listSyncMeta()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: "conversation-local-review-journal",
          reviewRepair: expect.objectContaining({
            sessionRevision: 1,
            review: expect.objectContaining({ score: 92, comment: "完整评分" }),
          }),
        }),
      ]),
    );
    sidecarGate.release();

    await write;
    expect(
      (await listSyncMeta()).find(
        (meta) => meta.conversationId === "conversation-local-review-journal",
      ),
    ).not.toHaveProperty("reviewRepair");
  });

  test("repairs a pending review journal even when sync is disabled", async () => {
    const conversationId = "conversation-repair-without-sync";
    const session = await seedPendingReviewRepair(conversationId);

    expect(await readSyncToken()).toBeNull();
    await runDailyStorySync();

    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: session.revision,
      review: {
        score: 92,
        comment: "本地修复",
        overallFeedback: "整体清晰。",
      },
    });
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).not.toHaveProperty("reviewRepair");
    expect(getStorySyncStatus()).toEqual({ status: "disabled", message: null });
  });

  test("keeps a review journal when sidecar repair fails with sync disabled", async () => {
    const conversationId = "conversation-repair-failure-without-sync";
    const session = await seedPendingReviewRepair(conversationId);
    await putMalformedReviewSidecar(conversationId);

    await runDailyStorySync();

    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).toMatchObject({
      reviewRepair: {
        sessionRevision: session.revision,
        sessionInstanceId: session.sessionInstanceId,
        review: { score: 92, comment: "本地修复" },
      },
    });
    expect(getStorySyncStatus()).toEqual({ status: "disabled", message: null });
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

  test("local deletes journal sidecar cleanup until it succeeds", async () => {
    const conversationId = "conversation-local-delete-journal";
    const saved = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "待删除故事",
        messages: [],
        review: { score: 88, comment: "待清理", rubric: null, suggestions: [] },
      },
      null,
    );
    const primaryGate = deferNextFakeIndexedDbTransaction();
    const deletion = deleteStorySession(conversationId, saved.revision);
    await primaryGate.started;
    primaryGate.release();

    const sidecarGate = deferNextFakeIndexedDbTransaction();
    await sidecarGate.started;
    expect(await listSyncMeta()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId,
          reviewRepair: expect.objectContaining({ operation: "delete", review: null }),
        }),
      ]),
    );
    sidecarGate.release();
    await deletion;
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).not.toHaveProperty("reviewRepair");
  });

  test("a stale success cannot lower the remote revision expected by a newer mutation", async () => {
    const first = await writeStorySession(
      "conversation-stale-remote-revision",
      { phase: "chatting", storyZh: "初始故事", messages: [] },
      null,
    );
    const firstMutation = (await listSyncOutbox()).find(
      (item) => item.conversationId === "conversation-stale-remote-revision",
    );
    if (!firstMutation) throw new Error("initial outbox missing");
    await markSyncSuccess(firstMutation, 5, first.revision);

    await writeStorySession(
      "conversation-stale-remote-revision",
      { phase: "chatting", storyZh: "更新故事", messages: [] },
      first.revision,
    );
    const newerMutation = (await listSyncOutbox()).find(
      (item) => item.conversationId === "conversation-stale-remote-revision",
    );
    if (!newerMutation) throw new Error("newer outbox missing");

    await markSyncSuccess(firstMutation, 3, first.revision);

    expect(
      (await listSyncOutbox()).find((item) => item.conversationId === firstMutation.conversationId),
    ).toMatchObject({ expectedRemoteRevision: 5, mutationId: newerMutation.mutationId });
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

  test("a remote tombstone for an already absent conversation needs no sidecar repair", async () => {
    await expect(applyRemoteStoryDeletion("conversation-already-absent", 3, null)).resolves.toBe(
      "applied",
    );
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === "conversation-already-absent"),
    ).not.toHaveProperty("reviewRepair");
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

  test("a successfully synced conflict copy resolves its matching upsert conflict", async () => {
    const copy: StorySession = {
      schemaVersion: 1,
      revision: 1,
      sessionInstanceId: "session-upsert-conflict-copy",
      updatedAt: "2026-08-15T00:00:00.000Z",
      phase: "chatting",
      storyZh: "冲突故事",
      messages: [{ id: "assistant_1", role: "assistant", text: "Hello." }],
    };
    const sourceConversationId = "conversation-upsert-conflict";
    const payload = toSyncConversation(copy, sourceConversationId);
    const key = conflictKey(sourceConversationId, "sync_mutation_upsert");
    const hash = await hashSyncPayload(payload);
    const conflictConversationId = await conflictConversationIdForPayload(
      sourceConversationId,
      payload,
    );

    await expect(
      createConflictCopyInTransaction(
        key,
        sourceConversationId,
        conflictConversationId,
        hash,
        copy,
      ),
    ).resolves.toBe("created");
    const item = (await listSyncOutbox()).find(
      (value) => value.conversationId === conflictConversationId,
    );
    expect(item?.operation).toBe("upsert");
    if (!item) throw new Error("conflict copy outbox missing");

    await markSyncSuccess(item, 1, item.localRevision);

    expect(
      (await listSyncConflicts()).find((conflict) => conflict.conflictKey === key),
    ).toMatchObject({ status: "resolved", conflictConversationId });
    expect(
      (await listSyncConflicts()).filter(
        (conflict) => conflict.conflictKey === key && conflict.status === "open",
      ),
    ).toHaveLength(0);
  });

  test("a stale conflict-copy success does not resolve its still-pending upsert conflict", async () => {
    const copy: StorySession = {
      schemaVersion: 1,
      revision: 1,
      sessionInstanceId: "session-stale-upsert-conflict-copy",
      updatedAt: "2026-08-15T00:00:00.000Z",
      phase: "chatting",
      storyZh: "冲突故事",
      messages: [{ id: "assistant_1", role: "assistant", text: "Hello." }],
    };
    const sourceConversationId = "conversation-stale-upsert-conflict";
    const payload = toSyncConversation(copy, sourceConversationId);
    const key = conflictKey(sourceConversationId, "sync_mutation_stale_upsert");
    const hash = await hashSyncPayload(payload);
    const conflictConversationId = await conflictConversationIdForPayload(
      sourceConversationId,
      payload,
    );

    await expect(
      createConflictCopyInTransaction(
        key,
        sourceConversationId,
        conflictConversationId,
        hash,
        copy,
      ),
    ).resolves.toBe("created");
    const staleItem = (await listSyncOutbox()).find(
      (value) => value.conversationId === conflictConversationId,
    );
    expect(staleItem?.operation).toBe("upsert");
    if (!staleItem) throw new Error("conflict copy outbox missing");

    await writeStorySession(conflictConversationId, { ...copy, title: "本地更新" }, copy.revision);
    await markSyncSuccess(staleItem, 1, staleItem.localRevision);

    expect(
      (await listSyncConflicts()).find((conflict) => conflict.conflictKey === key),
    ).toMatchObject({ status: "open", conflictConversationId });
    expect(
      (await listSyncOutbox()).find((value) => value.conversationId === conflictConversationId)
        ?.mutationId,
    ).not.toBe(staleItem.mutationId);
  });

  test("matching reviewRepair fallback preserves a full review through a suggestions-only title edit", async () => {
    const conversationId = "conversation-review-repair-fallback";
    const completeReview: DailyReview = {
      score: 90,
      comment: "保留完整评分",
      overallFeedback: "整体表达清晰。",
      rubric: null,
      suggestions: [],
    };
    const initial = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: completeReview,
      },
      null,
    );

    expect((await readStorySession(conversationId))?.review?.score).toBe(90);
    await putReviewRepairMarker(conversationId, initial.revision, initial.sessionInstanceId!, {
      ...completeReview,
      score: 95,
    });
    expect((await readStorySession(conversationId))?.review?.score).toBe(90);

    await deleteDailyStoryReview(conversationId);
    const recovered = await readStorySession(conversationId);
    expect(recovered?.review).toMatchObject({
      score: 95,
      comment: completeReview.comment,
      overallFeedback: completeReview.overallFeedback,
    });
    expect(
      (await listStorySessions()).find((session) => session.id === conversationId),
    ).toMatchObject({
      id: conversationId,
      review: { score: 95, comment: completeReview.comment },
    });

    await writeStorySession(
      conversationId,
      {
        phase: recovered!.phase,
        storyZh: recovered!.storyZh,
        messages: recovered!.messages,
        title: "修改后的标题",
        review: { suggestions: recovered!.review?.suggestions ?? [] },
      },
      recovered!.revision,
    );

    const persisted = await readStorySession(conversationId);
    expect(persisted).toMatchObject({
      title: "修改后的标题",
      review: {
        score: 95,
        comment: completeReview.comment,
        overallFeedback: completeReview.overallFeedback,
      },
    });
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).not.toHaveProperty("reviewRepair");
  });

  test("a malformed sidecar without a repair marker rejects instead of returning an empty review", async () => {
    const conversationId = "conversation-malformed-review-no-marker";
    const saved = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: { score: 90, comment: "真实评分", rubric: null, suggestions: [] },
      },
      null,
    );
    await putMalformedReviewSidecar(conversationId);

    await expect(readStorySession(conversationId)).rejects.toThrow();
    expect(saved.revision).toBe(1);
  });

  test("a malformed sidecar with a null repair marker still rejects", async () => {
    const conversationId = "conversation-malformed-review-null-marker";
    const saved = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: { score: 90, comment: "真实评分", rubric: null, suggestions: [] },
      },
      null,
    );
    await putMalformedReviewSidecar(conversationId);
    await putReviewRepairMarker(conversationId, saved.revision, saved.sessionInstanceId!, null);

    await expect(readStorySession(conversationId)).rejects.toThrow();
  });

  test("a malformed sidecar falls back to and preserves a matching full repair marker", async () => {
    const conversationId = "conversation-malformed-review-with-marker";
    const saved = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: { score: 90, comment: "旧评分", rubric: null, suggestions: [] },
      },
      null,
    );
    const repairedReview: DailyReview = {
      score: 95,
      comment: "远端完整评分",
      overallFeedback: "整体表达清晰。",
      rubric: null,
      suggestions: [],
    };
    await putMalformedReviewSidecar(conversationId);
    await putReviewRepairMarker(
      conversationId,
      saved.revision,
      saved.sessionInstanceId!,
      repairedReview,
    );

    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      review: repairedReview,
    });
    expect(
      (await listSyncMeta()).find((meta) => meta.conversationId === conversationId),
    ).toMatchObject({
      reviewRepair: { review: repairedReview },
    });
  });

  test("a missing sidecar and null repair marker preserve the primary suggestions-only review", async () => {
    const conversationId = "conversation-missing-review-null-marker";
    const saved = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: { score: null, comment: null, rubric: null, suggestions: [] },
      },
      null,
    );

    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      review: { score: null, comment: null, rubric: null, suggestions: [] },
    });
    await putReviewRepairMarker(conversationId, saved.revision, saved.sessionInstanceId!, null);
    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      review: { score: null, comment: null, rubric: null, suggestions: [] },
    });
  });

  test("reviewRepair from another session generation is not used as a fallback", async () => {
    const conversationId = "conversation-review-repair-generation";
    const initial = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "一个故事",
        messages: [],
        review: { score: 80, comment: "当前版本", rubric: null, suggestions: [] },
      },
      null,
    );
    await deleteDailyStoryReview(conversationId);
    await putReviewRepairMarker(conversationId, initial.revision, "session-different-generation", {
      score: 99,
      comment: "旧版本",
      rubric: null,
      suggestions: [],
    });

    expect((await readStorySession(conversationId))?.review).toMatchObject({
      score: null,
      comment: null,
      rubric: null,
      suggestions: [],
    });
  });

  test("same-generation review repair markers migrate after a newer local session wins", async () => {
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
    ).toMatchObject({
      reviewRepair: {
        operation: "upsert",
        sessionRevision: newer.revision,
        sessionInstanceId: newer.sessionInstanceId,
        review: null,
      },
    });
    expect((await readStorySession(conversationId))?.revision).toBe(newer.revision);
  });

  test("listing skips a session deleted after the initial session snapshot", async () => {
    const conversationId = "conversation-list-delete-race";
    const saved = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "待删除故事", messages: [] },
      null,
    );
    runAfterNextFakeSessionStoreGetAll(() => deleteStorySession(conversationId, saved.revision));

    await expect(listStorySessions()).resolves.toEqual([]);
  });

  test("listing uses one effective newer session snapshot after an update race", async () => {
    const conversationId = "conversation-list-update-race";
    const first = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "旧故事", messages: [] },
      null,
    );
    let newer: StorySession | undefined;
    runAfterNextFakeSessionStoreGetAll(async () => {
      newer = await writeStorySession(
        conversationId,
        {
          ...first,
          phase: "review",
          storyZh: "新故事",
          title: "新标题",
          review: { score: 88, comment: "新评分", rubric: null, suggestions: [] },
        },
        first.revision,
      );
    });

    const summary = (await listStorySessions()).find((session) => session.id === conversationId);
    expect(newer).toBeDefined();
    expect(summary).toMatchObject({
      id: conversationId,
      revision: newer!.revision,
      updatedAt: newer!.updatedAt,
      phase: "review",
      storyZh: "新故事",
      title: "新标题",
      review: { score: 88, comment: "新评分" },
    });
  });
});
