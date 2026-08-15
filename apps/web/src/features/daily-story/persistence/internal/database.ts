import { DailyStorageError, normalizeStorageError } from "../errors";

export const DB_NAME = "kotoba-loop-settings";
export const DB_VERSION = 3;
export const SETTINGS_STORE = "providerSettings";
export const SESSION_STORE = "storySessions";
export const LEASE_STORE = "storyLeases";
export const SYNC_CONFIG_STORE = "syncConfig";
export const SYNC_META_STORE = "syncMeta";
export const SYNC_OUTBOX_STORE = "syncOutbox";
export const SYNC_CONFLICT_STORE = "syncConflicts";
export const CURRENT = "current";
export const LEASE_MS = 15_000;
export const REVIEW_DB_NAME = "kotoba-daily-story-review-v2";
export const REVIEW_DB_VERSION = 1;
export const REVIEW_STORE = "reviews";

type DailyDatabase = IDBDatabase & {
  /** Chromium exposes this event when the connection is closed abnormally. */
  onclose?: ((event: Event) => void) | null;
};

let openPromise: Promise<IDBDatabase> | undefined;
let cachedDatabase: IDBDatabase | undefined;
let reviewOpenPromise: Promise<IDBDatabase> | undefined;
let cachedReviewDatabase: IDBDatabase | undefined;

export function resetCachedConnection() {
  const db = cachedDatabase;
  cachedDatabase = undefined;
  openPromise = undefined;
  try {
    db?.close();
  } catch {
    // The connection is already unusable; the next operation will reopen it.
  }
}

export function resetCachedReviewConnection() {
  const db = cachedReviewDatabase;
  cachedReviewDatabase = undefined;
  reviewOpenPromise = undefined;
  try {
    db?.close();
  } catch {
    // The connection is already unusable; the next operation will reopen it.
  }
}

export function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new DailyStorageError());
  if (!openPromise) {
    const pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        reject(new DailyStorageError());
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SETTINGS_STORE))
          db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SESSION_STORE))
          db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(LEASE_STORE))
          db.createObjectStore(LEASE_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SYNC_CONFIG_STORE))
          db.createObjectStore(SYNC_CONFIG_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SYNC_META_STORE))
          db.createObjectStore(SYNC_META_STORE, { keyPath: "conversationId" });
        if (!db.objectStoreNames.contains(SYNC_OUTBOX_STORE))
          db.createObjectStore(SYNC_OUTBOX_STORE, { keyPath: "conversationId" });
        if (!db.objectStoreNames.contains(SYNC_CONFLICT_STORE))
          db.createObjectStore(SYNC_CONFLICT_STORE, { keyPath: "conflictKey" });
      };
      request.onblocked = () => {
        resetCachedConnection();
        reject(
          new DailyStorageError(
            "浏览器正在阻止设置数据库升级。请关闭其它打开此应用的标签页后重试。",
          ),
        );
      };
      request.onerror = () => {
        reject(new DailyStorageError());
      };
      request.onsuccess = () => {
        const db = request.result;
        cachedDatabase = db;
        const dailyDb = db as DailyDatabase;
        const clearIfCached = () => {
          if (cachedDatabase !== db) return;
          cachedDatabase = undefined;
          openPromise = undefined;
        };
        dailyDb.onclose = clearIfCached;
        dailyDb.onversionchange = () => {
          db.close();
          clearIfCached();
        };
        resolve(db);
      };
    });
    const trackedPromise = pendingPromise.catch((error: unknown) => {
      if (openPromise === trackedPromise) openPromise = undefined;
      throw normalizeStorageError(error);
    });
    openPromise = trackedPromise;
  }
  return openPromise;
}

export function reviewDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new DailyStorageError());
  if (!reviewOpenPromise) {
    const pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(REVIEW_DB_NAME, REVIEW_DB_VERSION);
      } catch {
        reject(new DailyStorageError());
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REVIEW_STORE))
          db.createObjectStore(REVIEW_STORE, { keyPath: "conversationId" });
      };
      request.onerror = () => reject(new DailyStorageError());
      request.onsuccess = () => {
        const db = request.result;
        cachedReviewDatabase = db;
        const clearIfCached = () => {
          if (cachedReviewDatabase !== db) return;
          cachedReviewDatabase = undefined;
          reviewOpenPromise = undefined;
        };
        db.onclose = clearIfCached;
        db.onversionchange = () => {
          db.close();
          clearIfCached();
        };
        resolve(db);
      };
    });
    const trackedPromise = pendingPromise.catch((error: unknown) => {
      if (reviewOpenPromise === trackedPromise) reviewOpenPromise = undefined;
      throw normalizeStorageError(error);
    });
    reviewOpenPromise = trackedPromise;
  }
  return reviewOpenPromise;
}
