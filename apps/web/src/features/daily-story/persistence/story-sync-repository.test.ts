import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { installFakeIndexedDb } from "@/lib/practice/test/fakeIndexedDb";
import {
  ensureDailyStorage,
  deleteStorySession,
  listSyncOutbox,
  readSyncToken,
  writeStorySession,
  writeSyncToken,
} from ".";
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
});
