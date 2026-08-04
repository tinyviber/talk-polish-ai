import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetRecordingQueueForTests,
  enqueueRecording,
  getNextRecordingQueuePollAt,
  listRecordingQueue,
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

function createRecording(clientAttemptId: string) {
  return {
    learnerId: "device:learner-1",
    clientAttemptId,
    sessionId: null,
    clientSessionId: "session-1",
    promptId: "prompt-1",
    lang: "en" as const,
    attemptIndex: 1 as const,
    duration: 2,
    mimeType: "audio/webm",
    blob: new Blob([clientAttemptId], { type: "audio/webm" }),
    createdAt: 1,
  };
}

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function waitFor(condition: () => boolean, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    await flushMicrotasks();
  }
  throw new Error("Condition was not met in time.");
}

describe("offline queue sync loop", () => {
  let restoreIndexedDb: (() => void) | null = null;
  let originalWindow: unknown;
  let originalOnLine: PropertyDescriptor | undefined;
  let fakeWindow: FakeWindow;
  let fakeDocument: FakeDocument;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    restoreIndexedDb = installFakeIndexedDb();
    await __resetRecordingQueueForTests();
    fakeWindow = new FakeWindow();
    fakeDocument = new FakeDocument();
    originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
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

  test("retries a timed-out upload from persisted nextPollAt without an online event", async () => {
    let uploadCalls = 0;
    const stop = startOfflineQueueSyncLoop({
      getLearnerIds: () => ["device:learner-1"],
      getNextPollAt: getNextRecordingQueuePollAt,
      syncQueue: (learnerIds) =>
        syncRecordingQueue(async (item) => {
          uploadCalls += 1;
          if (uploadCalls === 1) {
            throw Object.assign(new Error("The API request timed out. Please try again."), {
              status: 0,
            });
          }
          return {
            id: `server-${item.clientAttemptId}`,
            status: "ready" as const,
            sessionId: "session-1",
          };
        }, learnerIds),
      doc: fakeDocument,
      nav: navigator,
      win: fakeWindow,
    });

    await enqueueRecording(createRecording("attempt-timeout"));
    await waitFor(() => uploadCalls === 1);
    expect(uploadCalls).toBe(1);

    const queued = (await listRecordingQueue("device:learner-1"))[0]!;
    expect(queued.syncStatus).toBe("queued");
    expect(queued.nextPollAt).toBe(1_000);

    await vi.advanceTimersByTimeAsync(999);
    await flushMicrotasks();
    expect(uploadCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(uploadCalls).toBe(2);

    const ready = (await listRecordingQueue("device:learner-1"))[0]!;
    expect(ready.syncStatus).toBe("ready");
    stop();
    await flushMicrotasks(20);
  });

  test("does not spin when internal queue notifications fire during sync", async () => {
    let syncCalls = 0;
    let uploadCalls = 0;
    const stop = startOfflineQueueSyncLoop({
      getLearnerIds: () => ["device:learner-1"],
      getNextPollAt: getNextRecordingQueuePollAt,
      syncQueue: async (learnerIds) => {
        syncCalls += 1;
        await syncRecordingQueue(async (item) => {
          uploadCalls += 1;
          return {
            id: `server-${item.clientAttemptId}`,
            status: "ready" as const,
            sessionId: "session-1",
          };
        }, learnerIds);
      },
      doc: fakeDocument,
      nav: navigator,
      win: fakeWindow,
    });

    await enqueueRecording(createRecording("attempt-no-spin"));
    await waitFor(() => syncCalls === 1);
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(syncCalls).toBe(1);
    expect(uploadCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    await flushMicrotasks(20);
  });
});
