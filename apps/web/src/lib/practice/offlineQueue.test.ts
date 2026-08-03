import { describe, expect, test } from "vitest";
import {
  cleanupRecordingQueue,
  isQueueSyncCandidate,
  orderQueueItems,
  recoverQueueStatus,
  subscribeRecordingQueue,
} from "./offlineQueue";

describe("offline recording queue boundaries", () => {
  test("is safe when IndexedDB is unavailable (SSR/private browser fallback)", async () => {
    await expect(cleanupRecordingQueue()).resolves.toBeUndefined();
  });

  test("unsubscribe does not retain queue listeners", () => {
    let calls = 0;
    const unsubscribe = subscribeRecordingQueue(() => {
      calls += 1;
    });
    unsubscribe();
    expect(calls).toBe(0);
  });

  test("never leaves an interrupted upload stranded", () => {
    expect(recoverQueueStatus("uploading")).toBe("queued");
    expect(isQueueSyncCandidate("queued")).toBe(true);
    expect(isQueueSyncCandidate("processing")).toBe(true);
    // A normal completed take belongs to the learner until they explicitly
    // submit it; foreground sync must never upload it automatically.
    expect(isQueueSyncCandidate("recorded-unsent")).toBe(false);
    expect(isQueueSyncCandidate("failed")).toBe(false);
  });

  test("orders attempts within a session before moving to later attempts", () => {
    const base = {
      learnerId: "learner-1",
      sessionId: null,
      promptId: "prompt-1",
      lang: "en" as const,
      duration: 1,
      mimeType: "audio/webm",
      blob: new Blob(["audio"]),
      createdAt: 1,
      syncStatus: "queued" as const,
    };
    const second = {
      ...base,
      clientSessionId: "session-a",
      clientAttemptId: "attempt-2",
      attemptIndex: 2 as const,
      createdAt: 1,
    };
    const first = {
      ...base,
      clientSessionId: "session-a",
      clientAttemptId: "attempt-1",
      attemptIndex: 1 as const,
      createdAt: 2,
    };
    expect(orderQueueItems([second, first]).map((item) => item.clientAttemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
  });
});
