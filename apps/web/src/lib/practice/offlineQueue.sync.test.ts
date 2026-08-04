import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetRecordingQueueForTests,
  cleanupRecordingQueue,
  enqueueRecording,
  getNextRecordingQueuePollAt,
  getRecordingQueueLeaseKey,
  listRecordingQueue,
  markRecordingReady,
  removeQueuedRecording,
  syncRecordingQueue,
} from "./offlineQueue";
import { startOfflineQueueSyncLoop } from "./offlineQueueSync";
import { installFakeIndexedDb } from "./test/fakeIndexedDb";

class FakeWindow extends EventTarget {
  readonly setTimeout = globalThis.setTimeout.bind(globalThis);
  readonly clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

function createRecording(
  clientAttemptId: string,
  overrides: Partial<Parameters<typeof enqueueRecording>[0]> = {},
) {
  return {
    learnerId: "device:learner-1",
    clientAttemptId,
    sessionId: null,
    clientSessionId: overrides.clientSessionId ?? "session-1",
    promptId: "prompt-1",
    lang: "en" as const,
    attemptIndex: 1 as const,
    duration: 2,
    mimeType: "audio/webm",
    blob: new Blob([clientAttemptId], { type: "audio/webm" }),
    createdAt: 1,
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function waitFor(condition: () => boolean, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    await flushMicrotasks();
  }
  throw new Error("Condition was not met in time.");
}

describe("offline queue sync behavior", () => {
  let restoreIndexedDb: (() => void) | null = null;
  let originalWindow: unknown;
  let originalOnLine: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    restoreIndexedDb = installFakeIndexedDb();
    await __resetRecordingQueueForTests();
    originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new FakeWindow(),
    });
    originalOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(async () => {
    await flushMicrotasks(20);
    await __resetRecordingQueueForTests();
    restoreIndexedDb?.();
    if (originalWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    if (originalOnLine) Object.defineProperty(navigator, "onLine", originalOnLine);
    else Reflect.deleteProperty(navigator as object, "onLine");
    vi.useRealTimers();
  });

  test("uses a stable lease key before and after learner bootstrap", () => {
    expect(getRecordingQueueLeaseKey(["device:abc-123"])).toBe("device:abc-123");
    expect(getRecordingQueueLeaseKey(["learner-42", "device:abc-123"])).toBe("device:abc-123");
    expect(getRecordingQueueLeaseKey(["device:abc-123", "learner-42"])).toBe("device:abc-123");
  });

  test("runs a trailing pass for items added while sync is already in flight", async () => {
    await enqueueRecording(createRecording("attempt-1"));

    let releaseFirstUpload:
      ((value: { id: string; status: "ready"; sessionId: string }) => void) | null = null;
    const upload = vi.fn(async (item) => {
      if (item.clientAttemptId === "attempt-1") {
        return await new Promise<{ id: string; status: "ready"; sessionId: string }>((resolve) => {
          releaseFirstUpload = resolve;
        });
      }
      return {
        id: `server-${item.clientAttemptId}`,
        status: "ready" as const,
        sessionId: `session-${item.clientAttemptId}`,
      };
    });

    const firstPass = syncRecordingQueue(upload, "device:learner-1");
    await waitFor(() => upload.mock.calls.length === 1);
    expect(upload).toHaveBeenCalledTimes(1);

    await enqueueRecording(createRecording("attempt-2", { createdAt: 2 }));
    const trailingPass = syncRecordingQueue(upload, "device:learner-1");

    releaseFirstUpload!({
      id: "server-attempt-1",
      status: "ready",
      sessionId: "session-attempt-1",
    });

    await firstPass;
    await trailingPass;

    expect(upload.mock.calls.map(([item]) => item.clientAttemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect((await listRecordingQueue("device:learner-1")).map((item) => item.syncStatus)).toEqual([
      "ready",
      "ready",
    ]);
  });

  test("does not regress an existing outbox attempt when a submit is replayed", async () => {
    const input = createRecording("attempt-replayed");

    await enqueueRecording(input);
    await markRecordingReady(input.clientAttemptId, {
      attemptId: "server-attempt-a",
      sessionId: "server-session-a",
    });
    await enqueueRecording({ ...input, blob: new Blob(["replacement"]) });

    const item = (await listRecordingQueue(input.learnerId))[0]!;
    expect(item.syncStatus).toBe("ready");
    expect(item.attemptId).toBe("server-attempt-a");
    expect(item.blobDiscarded).toBe(true);
  });

  test("keeps scheduling processing polls beyond 15.5 seconds", async () => {
    await enqueueRecording(createRecording("attempt-processing"));

    let uploadCalls = 0;
    const upload = vi.fn(async () => {
      uploadCalls += 1;
      if (uploadCalls <= 6) {
        return {
          id: "server-attempt-processing",
          status: "processing" as const,
          sessionId: "session-processing",
        };
      }
      return {
        id: "server-attempt-processing",
        status: "ready" as const,
        sessionId: "session-processing",
      };
    });

    const expectedPollTimes = [500, 1_500, 3_500, 7_500, 15_500, 23_500];

    for (const expectedPollAt of expectedPollTimes) {
      await syncRecordingQueue(upload, "device:learner-1");
      const item = (await listRecordingQueue("device:learner-1"))[0]!;
      expect(item.syncStatus).toBe("processing");
      expect(item.nextPollAt).toBe(expectedPollAt);
      vi.setSystemTime(new Date(expectedPollAt));
    }

    await syncRecordingQueue(upload, "device:learner-1");
    const item = (await listRecordingQueue("device:learner-1"))[0]!;
    expect(item.syncStatus).toBe("ready");
    expect(item.blobDiscarded).toBe(true);
    expect(item.blob.size).toBe(0);
  });

  test("keeps attempt two recoverable after a week offline", async () => {
    const learnerIds = ["device:learner-1", "lnr_old"];
    await enqueueRecording(createRecording("attempt-1", { createdAt: 0, learnerId: "lnr_old" }));
    await markRecordingReady("attempt-1", {
      attemptId: "server-attempt-1",
      sessionId: "session-1",
    });
    vi.setSystemTime(new Date(8 * 24 * 60 * 60 * 1000));
    await enqueueRecording(
      createRecording("attempt-2", {
        attemptIndex: 2,
        createdAt: Date.now(),
      }),
      learnerIds,
    );

    await cleanupRecordingQueue();
    expect((await listRecordingQueue(learnerIds)).map((item) => item.clientAttemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);

    // The prerequisite flag is durable even if a later cleanup pass removes
    // the ready metadata for attempt 1.
    await removeQueuedRecording("attempt-1");
    const upload = vi.fn(async (item) => ({
      id: `server-${item.clientAttemptId}`,
      status: "ready" as const,
      sessionId: "session-1",
    }));
    await syncRecordingQueue(upload, learnerIds);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0].clientAttemptId).toBe("attempt-2");
    expect((await listRecordingQueue(learnerIds))[0]?.syncStatus).toBe("ready");
  });

  test("backs off while another tab owns an expired processing lease", async () => {
    await __resetRecordingQueueForTests();
    vi.resetModules();
    const tabA = await import("./offlineQueue");
    vi.resetModules();
    const tabB = await import("./offlineQueue");

    await tabA.__resetRecordingQueueForTests();
    await tabA.enqueueRecording(createRecording("attempt-processing"));
    await tabA.syncRecordingQueue(
      async () => ({
        id: "server-attempt-processing",
        status: "processing" as const,
        sessionId: "session-1",
      }),
      "device:learner-1",
    );

    vi.setSystemTime(new Date(500));
    type UploadResult = { id: string; status: "ready"; sessionId: string };
    let releaseProcessing: ((result: UploadResult) => void) | null = null;
    const ownerUpload = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          releaseProcessing = resolve;
        }),
    );
    const ownerSync = tabA.syncRecordingQueue(ownerUpload, "device:learner-1");
    await waitFor(() => ownerUpload.mock.calls.length === 1);

    let losingTabSyncCalls = 0;
    const losingWindow = new FakeWindow();
    const losingDocument = new FakeDocument();
    const stop = startOfflineQueueSyncLoop({
      getLearnerIds: () => ["device:learner-1"],
      getNextPollAt: tabB.getNextRecordingQueuePollAt,
      syncQueue: (learnerIds) => {
        losingTabSyncCalls += 1;
        return tabB.syncRecordingQueue(
          async () => ({
            id: "should-not-upload",
            status: "ready" as const,
            sessionId: "session-1",
          }),
          learnerIds,
        );
      },
      doc: losingDocument,
      nav: navigator,
      win: losingWindow,
    });

    await waitFor(() => losingTabSyncCalls === 1);
    losingWindow.dispatchEvent(new Event("kotoba:queue-change"));
    losingWindow.dispatchEvent(new Event("online"));
    losingDocument.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(losingTabSyncCalls).toBe(1);

    releaseProcessing!({
      id: "server-attempt-processing",
      status: "ready",
      sessionId: "session-1",
    });
    await ownerSync;
    stop();
    await tabA.__resetRecordingQueueForTests();
    await tabB.__resetRecordingQueueForTests();
  });
});
