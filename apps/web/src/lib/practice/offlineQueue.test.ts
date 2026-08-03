import { describe, expect, test } from "vitest";
import {
  cleanupRecordingQueue,
  canSyncAttempt,
  isQueueSyncCandidate,
  orderRecordingQueue,
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
    expect(isQueueSyncCandidate("failed")).toBe(false);
  });

  test("orders by capture time and blocks attempt two until attempt one is ready", () => {
    const base = {
      learnerId: "learner",
      clientSessionId: "session",
      sessionId: null,
      promptId: "prompt",
      lang: "en" as const,
      duration: 1,
      mimeType: "audio/webm",
      blob: new Blob(["audio"], { type: "audio/webm" }),
    };
    const second = {
      ...base,
      clientAttemptId: "b",
      attemptIndex: 2 as const,
      createdAt: 2,
      syncStatus: "queued" as const,
    };
    const first = {
      ...base,
      clientAttemptId: "a",
      attemptIndex: 1 as const,
      createdAt: 1,
      syncStatus: "queued" as const,
    };
    expect(orderRecordingQueue([second, first]).map((item) => item.clientAttemptId)).toEqual([
      "a",
      "b",
    ]);
    expect(canSyncAttempt(second, [first, second])).toBe(false);
    expect(canSyncAttempt(second, [{ ...first, syncStatus: "ready" }])).toBe(true);
  });
});
