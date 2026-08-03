import { describe, expect, test } from "vitest";
import {
  enqueueRecording,
  saveRecordingDraft,
  subscribeRecordingQueue,
  syncRecordingQueue,
  type RecordingQueueItem,
} from "./offlineQueue";

type FakeRequest = {
  result?: unknown;
  error?: unknown;
  onupgradeneeded?: () => void;
  onsuccess?: () => void;
  onerror?: () => void;
};

type FakeState = {
  records: Map<string, RecordingQueueItem>;
  release: () => void;
};

let activeFake: FakeState | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function installFakeIndexedDb({ deferFirstPut = false } = {}) {
  if (activeFake) return activeFake;
  const records = new Map<string, RecordingQueueItem>();
  const putGate = deferred<void>();
  let putCount = 0;
  const store = {
    getAll() {
      const request: FakeRequest = {};
      queueMicrotask(() => {
        request.result = [...records.values()];
        request.onsuccess?.();
      });
      return request;
    },
    put(value: RecordingQueueItem) {
      const request: FakeRequest = {};
      queueMicrotask(async () => {
        if (deferFirstPut && putCount++ === 0) await putGate.promise;
        records.set(value.clientAttemptId, value);
        request.onsuccess?.();
      });
      return request;
    },
    delete(key: string) {
      const request: FakeRequest = {};
      queueMicrotask(() => {
        records.delete(key);
        request.onsuccess?.();
      });
      return request;
    },
  };
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
  };
  const factory = {
    open: () => {
      const request: FakeRequest = { result: db };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      onLine: true,
      locks: { request: (_name: string, _options: unknown, work: () => Promise<void>) => work() },
    },
  });
  activeFake = { records, release: () => putGate.resolve() };
  return activeFake;
}

function item(overrides: Partial<RecordingQueueItem> = {}): RecordingQueueItem {
  return {
    learnerId: "learner-1",
    clientAttemptId: "attempt-1",
    sessionId: "session-1",
    clientSessionId: "client-session-1",
    promptId: "prompt-1",
    promptText: "Tell me about your day.",
    lang: "en",
    attemptIndex: 1,
    duration: 4,
    mimeType: "audio/webm",
    blob: new Blob(["audio"], { type: "audio/webm" }),
    createdAt: Date.now(),
    syncStatus: "queued",
    ...overrides,
  };
}

describe("offline queue persistence and trailing sync", () => {
  test("keeps draft save pending while IndexedDB put is deferred", async () => {
    const fake = installFakeIndexedDb({ deferFirstPut: true });
    const { syncStatus: _syncStatus, ...draft } = item();
    const save = saveRecordingDraft(draft);
    let settled = false;
    void save.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.release();
    await expect(save).resolves.toBe("attempt-1");
    expect(fake.records.get("attempt-1")?.syncStatus).toBe("recorded-unsent");
  });

  test("runs trailing pass when another queued item arrives during sync", async () => {
    const fake = installFakeIndexedDb();
    const started = deferred<void>();
    const allowFirst = deferred<void>();
    const uploaded: string[] = [];
    let first = true;
    const upload = async (queued: RecordingQueueItem) => {
      uploaded.push(queued.clientAttemptId);
      if (first) {
        first = false;
        started.resolve();
        await allowFirst.promise;
      }
      return { id: `server-${queued.clientAttemptId}`, status: "ready" as const };
    };
    const unsubscribe = subscribeRecordingQueue(() => {
      void syncRecordingQueue(upload, "learner-1");
    });
    await enqueueRecording(item());
    const sync = syncRecordingQueue(upload, "learner-1");
    await started.promise;
    await enqueueRecording(item({ clientAttemptId: "attempt-2", createdAt: Date.now() + 1 }));
    allowFirst.resolve();
    await sync;
    unsubscribe();

    expect(uploaded).toEqual(["attempt-1", "attempt-2"]);
    expect(fake.records.get("attempt-2")?.syncStatus).toBe("ready");
  });
});
