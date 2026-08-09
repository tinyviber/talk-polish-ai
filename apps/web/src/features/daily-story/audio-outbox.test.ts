import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { installFakeIndexedDb } from "@/lib/practice/test/fakeIndexedDb";
import {
  DAILY_STORY_AUDIO_OUTBOX_TTL_MS,
  __resetDailyStoryAudioOutboxForTests,
  get,
  list,
  put,
  remove,
  update,
} from "./audio-outbox";

let restoreIndexedDb: () => void;

beforeAll(() => {
  restoreIndexedDb = installFakeIndexedDb();
});

beforeEach(async () => {
  vi.useRealTimers();
  await __resetDailyStoryAudioOutboxForTests();
});

afterAll(() => restoreIndexedDb());

describe("Daily Story audio outbox", () => {
  test("persists a recording with the metadata needed for a later upload", async () => {
    const createdAt = Date.now();
    const blob = new Blob(["audio"], { type: "audio/webm;codecs=opus" });

    const saved = await put({
      clientAttemptId: "attempt-1",
      conversationId: "conversation-1",
      blob,
      mimeType: blob.type,
      durationSec: 4.25,
      createdAt,
    });

    expect(saved).toMatchObject({
      clientAttemptId: "attempt-1",
      conversationId: "conversation-1",
      mimeType: "audio/webm;codecs=opus",
      durationSec: 4.25,
      createdAt,
      status: "queued",
      purpose: "conversation",
    });
    expect(saved.blob.size).toBe(blob.size);
    expect((await get("attempt-1"))?.conversationId).toBe("conversation-1");
    expect(await list()).toHaveLength(1);
  });

  test("persists read-aloud purpose and target", async () => {
    const saved = await put({
      clientAttemptId: "read-attempt",
      conversationId: "conversation-1",
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      createdAt: Date.now(),
      purpose: "readAloud",
      readAloudTarget: "I went home.",
    });

    expect(saved).toMatchObject({ purpose: "readAloud", readAloudTarget: "I went home." });
    expect(await get("read-attempt")).toMatchObject({
      purpose: "readAloud",
      readAloudTarget: "I went home.",
    });
  });

  test("migrates legacy records to conversation purpose", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("kotoba-daily-story-audio", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("audioOutbox", { keyPath: "clientAttemptId" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("audioOutbox", "readwrite");
        tx.objectStore("audioOutbox").put({
          clientAttemptId: "legacy",
          conversationId: "conversation-1",
          blob: new Blob(["audio"], { type: "audio/webm" }),
          mimeType: "audio/webm",
          durationSec: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "failed",
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    await expect(get("legacy")).resolves.toMatchObject({ purpose: "conversation" });
  });

  test("is idempotent by clientAttemptId and never resets an existing item", async () => {
    const first = await put({
      clientAttemptId: "same-attempt",
      conversationId: "conversation-1",
      blob: new Blob(["first"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      createdAt: Date.now(),
    });
    await update("same-attempt", { status: "uploading" });

    const retry = await put({
      clientAttemptId: "same-attempt",
      conversationId: "conversation-2",
      blob: new Blob(["second"], { type: "audio/ogg" }),
      mimeType: "audio/ogg",
      durationSec: 8,
      createdAt: 200,
      status: "queued",
    });

    expect(retry).toMatchObject({
      clientAttemptId: first.clientAttemptId,
      conversationId: first.conversationId,
      mimeType: first.mimeType,
      durationSec: first.durationSec,
      createdAt: first.createdAt,
      status: "uploading",
    });
    expect((await list()).map((item) => item.clientAttemptId)).toEqual(["same-attempt"]);
    expect((await get("same-attempt"))?.conversationId).toBe("conversation-1");
  });

  test("updates upload status and supports clearing an error", async () => {
    await put({
      clientAttemptId: "attempt-2",
      conversationId: "conversation-1",
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      createdAt: Date.now(),
    });

    const failed = await update("attempt-2", {
      status: "failed",
      error: "provider unavailable",
    });
    expect(failed).toMatchObject({ status: "failed", error: "provider unavailable" });

    const completed = await update("attempt-2", { status: "completed", error: null });
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed?.error).toBeUndefined();
    expect(await update("missing", { status: "failed" })).toBeUndefined();
  });

  test("lists by conversation and status, and removes an item", async () => {
    const base = {
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      createdAt: Date.now(),
    };
    await put({ ...base, clientAttemptId: "a", conversationId: "one" });
    await put({
      ...base,
      clientAttemptId: "b",
      conversationId: "one",
      createdAt: base.createdAt + 1,
      status: "failed",
    });
    await put({
      ...base,
      clientAttemptId: "c",
      conversationId: "two",
      createdAt: base.createdAt + 2,
    });

    expect((await list({ conversationId: "one" })).map((item) => item.clientAttemptId)).toEqual([
      "a",
      "b",
    ]);
    expect((await list({ status: "failed" })).map((item) => item.clientAttemptId)).toEqual(["b"]);
    expect(await remove("b")).toBe(true);
    expect(await remove("b")).toBe(false);
    expect((await list()).map((item) => item.clientAttemptId)).toEqual(["a", "c"]);
  });

  test("removes records older than the seven-day TTL", async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const base = {
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      conversationId: "conversation-1",
    };
    await put({
      ...base,
      clientAttemptId: "expired",
      createdAt: now - DAILY_STORY_AUDIO_OUTBOX_TTL_MS - 1,
    });
    await put({ ...base, clientAttemptId: "fresh", createdAt: now });

    expect((await list()).map((item) => item.clientAttemptId)).toEqual(["fresh"]);
    expect(await get("expired")).toBeUndefined();
  });
});
