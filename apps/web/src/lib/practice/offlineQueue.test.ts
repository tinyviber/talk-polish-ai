import { describe, expect, test, vi } from "vitest";
import {
  cleanupRecordingQueue,
  canSyncAttempt,
  isQueueSyncCandidate,
  migrateRecordingQueueRecord,
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

  test("closes the cross-tab channel when the last subscriber leaves", () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    const close = vi.fn();
    class FakeBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage() {}
      close = close;
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    try {
      const unsubscribe = subscribeRecordingQueue(() => {});
      unsubscribe();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      if (originalBroadcastChannel === undefined)
        delete (globalThis as typeof globalThis & { BroadcastChannel?: unknown }).BroadcastChannel;
      else vi.stubGlobal("BroadcastChannel", originalBroadcastChannel);
    }
  });

  test("never leaves an interrupted upload stranded", () => {
    expect(recoverQueueStatus("uploading")).toBe("queued");
    expect(isQueueSyncCandidate("queued")).toBe(true);
    expect(isQueueSyncCandidate("uploading")).toBe(true);
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
    expect(
      canSyncAttempt({ ...second, prerequisiteSatisfied: true }, [
        { ...second, prerequisiteSatisfied: true },
      ]),
    ).toBe(true);
    expect(
      canSyncAttempt(
        { ...second, learnerId: "device:learner" },
        [{ ...first, learnerId: "lnr_old", syncStatus: "ready" }],
        ["device:learner", "lnr_old"],
      ),
    ).toBe(true);
  });

  test("only preserves explicitly pending v5 feedback during migration", () => {
    const base = {
      learnerId: "learner",
      clientAttemptId: "attempt",
      sessionId: "session",
      clientSessionId: "session",
      promptId: "prompt",
      lang: "en" as const,
      attemptIndex: 1 as const,
      syncStatus: "ready" as const,
      createdAt: 1,
    };
    expect(migrateRecordingQueueRecord(base, 4)).toMatchObject({
      feedbackState: "delivered",
      workflowState: "consumed",
    });
    expect(
      migrateRecordingQueueRecord(
        {
          ...base,
          feedbackState: "pending",
          workflowState: "awaiting-feedback",
        },
        5,
      ),
    ).toMatchObject({
      feedbackState: "pending",
      workflowState: "awaiting-feedback",
    });
  });

  test("waits for transaction commit so an abort after request success never looks durable", async () => {
    const originalIndexedDB = globalThis.indexedDB;
    const originalBroadcastChannel = globalThis.BroadcastChannel;

    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("indexedDB", createAbortAfterSuccessIndexedDB());
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    try {
      const { enqueueRecording, listRecordingQueue, subscribeRecordingQueue, syncRecordingQueue } =
        await import("./offlineQueue");

      let queueChanges = 0;
      const unsubscribe = subscribeRecordingQueue(() => {
        queueChanges += 1;
      });

      const input = {
        learnerId: "learner-a",
        clientAttemptId: "attempt-a",
        sessionId: null,
        clientSessionId: "session-a",
        promptId: "prompt-a",
        lang: "en" as const,
        attemptIndex: 1 as const,
        duration: 1,
        mimeType: "audio/webm",
        blob: new Blob(["audio"], { type: "audio/webm" }),
        createdAt: 1_000,
      };

      await expect(enqueueRecording(input)).rejects.toThrow(
        /recordings transaction aborted after request success/i,
      );
      expect(queueChanges).toBe(0);
      expect(input.blob.size).toBe(5);
      await expect(listRecordingQueue(input.learnerId)).resolves.toEqual([]);

      const upload = vi.fn();
      await syncRecordingQueue(upload, input.learnerId);
      expect(upload).not.toHaveBeenCalled();

      unsubscribe();
    } finally {
      if (originalIndexedDB === undefined)
        delete (globalThis as typeof globalThis & { indexedDB?: unknown }).indexedDB;
      else vi.stubGlobal("indexedDB", originalIndexedDB);

      if (originalBroadcastChannel === undefined)
        delete (globalThis as typeof globalThis & { BroadcastChannel?: unknown }).BroadcastChannel;
      else vi.stubGlobal("BroadcastChannel", originalBroadcastChannel);

      Reflect.deleteProperty(navigator as object, "onLine");
      vi.resetModules();
    }
  });
});

function createAbortAfterSuccessIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string>();

  const cloneValue = <T>(value: T) =>
    typeof structuredClone === "function" ? structuredClone(value) : value;

  const schedule = (fn: () => void) => queueMicrotask(fn);

  class FakeTransaction {
    public error: Error | null = null;
    public oncomplete: ((event: Event) => void) | null = null;
    public onabort: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    private readonly pendingCommits: Array<() => void> = [];
    private pendingRequests = 0;
    private settled = false;

    constructor(
      private readonly storeName: string,
      private readonly mode: IDBTransactionMode,
    ) {}

    objectStore(name: string) {
      if (name !== this.storeName) throw new Error(`Unknown store: ${name}`);
      return new FakeObjectStore(this, name, this.mode);
    }

    addCommit(commit: () => void) {
      this.pendingCommits.push(commit);
    }

    trackRequest() {
      this.pendingRequests += 1;
    }

    finishRequest() {
      this.pendingRequests -= 1;
      schedule(() => this.maybeSettle());
    }

    requestSucceeded() {
      return this.storeName === "recordings" && this.mode === "readwrite";
    }

    private maybeSettle() {
      if (this.settled || this.pendingRequests > 0) return;
      if (this.requestSucceeded()) {
        this.settled = true;
        this.error = new Error("recordings transaction aborted after request success");
        this.onabort?.(new Event("abort"));
        return;
      }
      this.settled = true;
      for (const commit of this.pendingCommits) commit();
      this.oncomplete?.(new Event("complete"));
    }
  }

  class FakeObjectStore {
    constructor(
      private readonly tx: FakeTransaction,
      private readonly storeName: string,
      private readonly mode: IDBTransactionMode,
    ) {}

    getAll() {
      const request = createRequest<unknown[]>();
      this.tx.trackRequest();
      schedule(() => {
        request.result = Array.from(stores.get(this.storeName)?.values() ?? []).map((value) =>
          cloneValue(value),
        );
        request.onsuccess?.(new Event("success"));
        this.tx.finishRequest();
      });
      return request;
    }

    get(key: string) {
      const request = createRequest<unknown>();
      this.tx.trackRequest();
      schedule(() => {
        request.result = cloneValue(stores.get(this.storeName)?.get(key));
        request.onsuccess?.(new Event("success"));
        this.tx.finishRequest();
      });
      return request;
    }

    put(value: Record<string, unknown>) {
      if (this.mode !== "readwrite") throw new Error("Cannot write in readonly transaction");
      const request = createRequest<string>();
      const keyPath = keyPaths.get(this.storeName);
      const key = String(value[keyPath ?? "id"]);
      this.tx.trackRequest();
      this.tx.addCommit(() => {
        const store = stores.get(this.storeName);
        if (!store) throw new Error(`Missing store: ${this.storeName}`);
        store.set(key, cloneValue(value));
      });
      schedule(() => {
        request.result = key;
        request.onsuccess?.(new Event("success"));
        this.tx.finishRequest();
      });
      return request;
    }

    delete(key: string) {
      if (this.mode !== "readwrite") throw new Error("Cannot write in readonly transaction");
      const request = createRequest<void>();
      this.tx.trackRequest();
      this.tx.addCommit(() => {
        stores.get(this.storeName)?.delete(key);
      });
      schedule(() => {
        request.result = undefined;
        request.onsuccess?.(new Event("success"));
        this.tx.finishRequest();
      });
      return request;
    }
  }

  function createRequest<T>() {
    return {
      error: null as Error | null,
      result: undefined as T | undefined,
      onerror: null as ((event: Event) => void) | null,
      onsuccess: null as ((event: Event) => void) | null,
    };
  }

  const db = {
    close() {},
    createObjectStore(name: string, options?: { keyPath?: string }) {
      if (!stores.has(name)) stores.set(name, new Map());
      if (options?.keyPath) keyPaths.set(name, options.keyPath);
      return {};
    },
    objectStoreNames: {
      contains(name: string) {
        return stores.has(name);
      },
    },
    transaction(storeName: string, mode: IDBTransactionMode) {
      return new FakeTransaction(storeName, mode);
    },
    onversionchange: null as ((event: Event) => void) | null,
  };

  return {
    open() {
      const request = {
        error: null as Error | null,
        onblocked: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onupgradeneeded: null as ((event: Event) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        result: db,
        transaction: undefined as undefined,
      };
      schedule(() => {
        if (!stores.has("recordings")) {
          request.onupgradeneeded?.(new Event("upgradeneeded"));
        }
        schedule(() => {
          request.onsuccess?.(new Event("success"));
        });
      });
      return request;
    },
  };
}
