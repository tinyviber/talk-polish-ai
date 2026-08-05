import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetRecordingQueueForTests,
  enqueueRecording,
  getNextRecordingQueuePollAt,
  listDurablePracticeWorkflows,
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

async function putQueueItemDirectly(item: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kotoba-loop-offline", 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("recordings", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("queue seed aborted"));
    tx.objectStore("recordings").put(item);
  });
  db.close();
}

async function seedLegacyQueueItem(item: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kotoba-loop-offline", 4);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "clientAttemptId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("recordings", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("legacy queue seed aborted"));
    tx.objectStore("recordings").put(item);
  });
  db.close();
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

  test("recovers an uploading item on a fresh sync-loop start", async () => {
    await enqueueRecording(createRecording("attempt-crashed-upload"));
    await putQueueItemDirectly({
      ...createRecording("attempt-crashed-upload"),
      syncStatus: "uploading",
    });

    let uploadCalls = 0;
    const stop = startOfflineQueueSyncLoop({
      getLearnerIds: () => ["device:learner-1"],
      getNextPollAt: getNextRecordingQueuePollAt,
      syncQueue: (learnerIds) =>
        syncRecordingQueue(async (item) => {
          uploadCalls += 1;
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

    await waitFor(() => uploadCalls === 1);
    expect((await listRecordingQueue("device:learner-1"))[0]?.syncStatus).toBe("ready");
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

  test("migrates a historical ready row as consumed instead of replaying feedback", async () => {
    await seedLegacyQueueItem({
      learnerId: "device:learner-1",
      clientAttemptId: "historical-ready",
      sessionId: "session-1",
      clientSessionId: "session-1",
      promptId: "prompt-1",
      lang: "en",
      attemptIndex: 1,
      duration: 2,
      mimeType: "audio/webm",
      blob: new Blob([], { type: "audio/webm" }),
      createdAt: 1,
      syncStatus: "ready",
      attemptId: "server-historical-ready",
    });

    const rows = await listRecordingQueue("device:learner-1");
    expect(rows[0]?.workflowState).toBe("consumed");
    expect(rows[0]?.feedbackState).toBe("delivered");
    await expect(listDurablePracticeWorkflows(["device:learner-1"])).resolves.toEqual([]);
  });
});
