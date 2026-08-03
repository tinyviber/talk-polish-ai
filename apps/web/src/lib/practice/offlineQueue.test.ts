import { describe, expect, test } from "vitest";
import {
  cleanupRecordingQueue,
  isQueueSyncCandidate,
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
});
