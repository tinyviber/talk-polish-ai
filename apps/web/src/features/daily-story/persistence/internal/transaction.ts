import {
  database,
  reviewDatabase,
  resetCachedConnection,
  resetCachedReviewConnection,
  SESSION_STORE,
  LEASE_STORE,
  REVIEW_STORE,
} from "./database";
import { isRecoverableDatabaseError, normalizeStorageError, DailyStorageError } from "../errors";

type TransactionRunner = (tx: IDBTransaction, abort: (error: unknown) => void) => void;

function runTransaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: TransactionRunner,
) {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let tx: IDBTransaction;
        let failure: unknown;
        let aborted = false;
        const abort = (error: unknown) => {
          failure = error;
          if (aborted) return;
          aborted = true;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          tx = db.transaction(stores, mode);
          tx.oncomplete = () => resolve(result!);
          tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new DailyStorageError());
          (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult = (
            value,
          ) => {
            result = value;
          };
          run(tx, abort);
        } catch (error) {
          abort(error);
        }
      }),
  );
}

export function transaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: TransactionRunner,
) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runTransaction<T>(stores, mode, run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}

function runReviewTransaction<T>(mode: IDBTransactionMode, run: TransactionRunner) {
  return reviewDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let tx: IDBTransaction;
        let failure: unknown;
        let aborted = false;
        const abort = (error: unknown) => {
          failure = error;
          if (aborted) return;
          aborted = true;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          tx = db.transaction(REVIEW_STORE, mode);
          tx.oncomplete = () => resolve(result!);
          tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new DailyStorageError());
          (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult = (
            value,
          ) => {
            result = value;
          };
          run(tx, abort);
        } catch (error) {
          abort(error);
        }
      }),
  );
}

export function reviewTransaction<T>(mode: IDBTransactionMode, run: TransactionRunner) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runReviewTransaction<T>(mode, run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedReviewConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}

export function setResult<T>(tx: IDBTransaction, value: T) {
  (tx as IDBTransaction & { __dailyResult?: (value: T) => void }).__dailyResult?.(value);
}

type SessionImportRunner<T> = (
  tx: IDBTransaction,
  setTransactionResult: (value: T) => void,
  abort: (error: unknown) => void,
) => void;

function runSessionImportTransaction<T>(run: SessionImportRunner<T>) {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let failure: unknown;
        let tx: IDBTransaction | undefined;
        const abort = (error: unknown) => {
          failure = error;
          if (!tx) {
            reject(error);
            return;
          }
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        };
        try {
          const opened = db.transaction([SESSION_STORE, LEASE_STORE], "readwrite");
          tx = opened;
          opened.oncomplete = () => resolve(result!);
          opened.onerror = opened.onabort = () =>
            reject(failure ?? opened.error ?? new DailyStorageError());
          run(
            opened,
            (value) => {
              result = value;
            },
            abort,
          );
        } catch (error) {
          failure = error;
          if (!tx) {
            reject(error);
            return;
          }
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        }
      }),
  );
}

export function sessionImportTransaction<T>(run: SessionImportRunner<T>) {
  const attempt = (canRecover: boolean): Promise<T> =>
    runSessionImportTransaction(run).catch((error: unknown) => {
      if (canRecover && isRecoverableDatabaseError(error)) {
        resetCachedConnection();
        return attempt(false);
      }
      throw normalizeStorageError(error);
    });
  return attempt(true);
}
