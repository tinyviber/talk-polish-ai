export const DAILY_STORY_AUDIO_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "kotoba-daily-story-audio";
const DB_VERSION = 2;
const STORE_NAME = "audioOutbox";

export type DailyStoryAudioOutboxStatus = "queued" | "uploading" | "failed" | "completed";
export type DailyStoryAudioPurpose = "conversation" | "readAloud";

export type DailyStoryAudioOutboxItem = {
  clientAttemptId: string;
  conversationId: string;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: number;
  updatedAt: number;
  status: DailyStoryAudioOutboxStatus;
  purpose: DailyStoryAudioPurpose;
  readAloudTarget?: string;
  error?: string;
};

export type DailyStoryAudioOutboxInput = Omit<
  DailyStoryAudioOutboxItem,
  "status" | "updatedAt" | "purpose"
> & {
  status?: DailyStoryAudioOutboxStatus;
  purpose?: DailyStoryAudioPurpose;
  error?: string;
};

export type DailyStoryAudioOutboxUpdate = Partial<
  Pick<
    DailyStoryAudioOutboxItem,
    | "conversationId"
    | "blob"
    | "mimeType"
    | "durationSec"
    | "status"
    | "purpose"
    | "readAloudTarget"
  >
> & {
  error?: string | null;
};

export type ListDailyStoryAudioOutboxOptions = {
  conversationId?: string;
  status?: DailyStoryAudioOutboxStatus;
};

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (databasePromise) return databasePromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "clientAttemptId" });
        return;
      }
      if (request.transaction && (event as IDBVersionChangeEvent).oldVersion < 2) {
        const store = request.transaction.objectStore(STORE_NAME);
        const records = store.getAll();
        records.onsuccess = () => {
          for (const record of records.result as Array<
            DailyStoryAudioOutboxItem & { purpose?: string }
          >) {
            if (!record.purpose) store.put({ ...record, purpose: "conversation" });
          }
        };
      }
    };
    request.onblocked = () => reject(new Error("Daily Story audio database upgrade is blocked"));
    request.onerror = () => reject(request.error ?? new Error("Unable to open audio outbox"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    if (databasePromise === promise) databasePromise = undefined;
    throw error;
  });

  databasePromise = promise;
  return promise;
}

function waitForWriteTransaction(tx: IDBTransaction, request?: IDBRequest) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const error = () =>
      tx.error ?? request?.error ?? new Error("Daily Story audio outbox transaction failed");

    tx.oncomplete = () => finish(resolve);
    tx.onerror = () => finish(() => reject(error()));
    tx.onabort = () => finish(() => reject(error()));
    if (request) request.onerror = () => finish(() => reject(error()));
  });
}

function assertInput(input: DailyStoryAudioOutboxInput) {
  if (!input.clientAttemptId.trim()) throw new Error("clientAttemptId is required");
  if (!input.conversationId.trim()) throw new Error("conversationId is required");
  if (!input.mimeType.trim()) throw new Error("mimeType is required");
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) {
    throw new Error("durationSec must be a non-negative number");
  }
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0) {
    throw new Error("createdAt must be a non-negative timestamp");
  }
  const purpose = input.purpose ?? "conversation";
  if (purpose !== "conversation" && purpose !== "readAloud") {
    throw new Error("purpose must be conversation or readAloud");
  }
  if (purpose === "readAloud" && !input.readAloudTarget?.trim()) {
    throw new Error("readAloudTarget is required for readAloud audio");
  }
  return purpose;
}

function isExpired(item: Pick<DailyStoryAudioOutboxItem, "createdAt">, now: number) {
  return item.createdAt < now - DAILY_STORY_AUDIO_OUTBOX_TTL_MS;
}

async function removeExpired(now = Date.now()) {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  request.onsuccess = () => {
    for (const item of request.result as DailyStoryAudioOutboxItem[]) {
      if (isExpired(item, now)) store.delete(item.clientAttemptId);
    }
  };
  await waitForWriteTransaction(tx, request);
}

export async function put(input: DailyStoryAudioOutboxInput): Promise<DailyStoryAudioOutboxItem> {
  const purpose = assertInput(input);
  await removeExpired();

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(input.clientAttemptId);
  let persisted: DailyStoryAudioOutboxItem | undefined;

  request.onsuccess = () => {
    const current = request.result as DailyStoryAudioOutboxItem | undefined;
    if (current) {
      persisted = current;
      return;
    }

    persisted = {
      clientAttemptId: input.clientAttemptId,
      conversationId: input.conversationId,
      blob: input.blob,
      mimeType: input.mimeType,
      durationSec: input.durationSec,
      createdAt: input.createdAt,
      updatedAt: Date.now(),
      status: input.status ?? "queued",
      purpose,
      ...(input.readAloudTarget ? { readAloudTarget: input.readAloudTarget } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    store.put(persisted);
  };

  await waitForWriteTransaction(tx, request);
  if (!persisted) throw new Error("Daily Story audio outbox item was not persisted");
  return persisted;
}

export async function list(
  options: ListDailyStoryAudioOutboxOptions = {},
): Promise<DailyStoryAudioOutboxItem[]> {
  await removeExpired();
  const db = await openDatabase();
  return new Promise<DailyStoryAudioOutboxItem[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const items = (request.result as DailyStoryAudioOutboxItem[])
        .filter((item) =>
          options.conversationId ? item.conversationId === options.conversationId : true,
        )
        .filter((item) => (options.status ? item.status === options.status : true))
        .sort(
          (a, b) => a.createdAt - b.createdAt || a.clientAttemptId.localeCompare(b.clientAttemptId),
        );
      resolve(items);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to list audio outbox"));
  });
}

export async function get(clientAttemptId: string): Promise<DailyStoryAudioOutboxItem | undefined> {
  await removeExpired();
  const db = await openDatabase();
  return new Promise<DailyStoryAudioOutboxItem | undefined>((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(clientAttemptId);
    request.onsuccess = () => resolve(request.result as DailyStoryAudioOutboxItem | undefined);
    request.onerror = () => reject(request.error ?? new Error("Unable to read audio outbox"));
  });
}

export async function update(
  clientAttemptId: string,
  changes: DailyStoryAudioOutboxUpdate,
): Promise<DailyStoryAudioOutboxItem | undefined> {
  await removeExpired();
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(clientAttemptId);
  let updated: DailyStoryAudioOutboxItem | undefined;

  request.onsuccess = () => {
    const current = request.result as DailyStoryAudioOutboxItem | undefined;
    if (!current) return;

    const { error, ...rest } = changes;
    updated = {
      ...current,
      ...rest,
      updatedAt: Date.now(),
      ...(error === null
        ? {}
        : error === undefined
          ? current.error
            ? { error: current.error }
            : {}
          : { error }),
    };
    if (error === null) delete updated.error;
    store.put(updated);
  };

  await waitForWriteTransaction(tx, request);
  return updated;
}

export async function remove(clientAttemptId: string): Promise<boolean> {
  await removeExpired();
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(clientAttemptId);
  let existed = false;

  request.onsuccess = () => {
    existed = request.result !== undefined;
    if (existed) store.delete(clientAttemptId);
  };

  await waitForWriteTransaction(tx, request);
  return existed;
}

/** Test-only reset; keeps each unit test isolated without exposing DB internals to callers. */
export async function __resetDailyStoryAudioOutboxForTests() {
  const db = await databasePromise?.catch(() => undefined);
  db?.close();
  databasePromise = undefined;
  if (typeof indexedDB === "undefined") return;

  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
