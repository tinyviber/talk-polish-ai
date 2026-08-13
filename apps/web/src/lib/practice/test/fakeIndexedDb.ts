type StoreData = {
  keyPath: string;
  records: Map<IDBValidKey, unknown>;
};

type DatabaseData = {
  version: number;
  stores: Map<string, StoreData>;
};

type TransactionGate = {
  promise: Promise<void>;
  release: () => void;
};

let nextTransactionGate: TransactionGate | undefined;

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
    if (value && typeof value === "object") return { ...(value as Record<string, unknown>) } as T;
    return value;
  }
}

function createRequest<T>() {
  return {
    result: undefined as T,
    error: null as Error | null,
    onsuccess: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
  };
}

function createObjectStoreHandle(store: StoreData, tx: ReturnType<typeof createTransaction>) {
  const run = <T>(action: () => T) => tx.run(action);
  return {
    getAll: () => run(() => Array.from(store.records.values()).map((value) => clone(value))),
    getAllKeys: () => run(() => Array.from(store.records.keys())),
    get: (key: IDBValidKey) => run(() => clone(store.records.get(key))),
    put: (value: Record<string, unknown>) =>
      run(() => {
        const record = clone(value);
        const key = record[store.keyPath] as IDBValidKey;
        store.records.set(key, record);
        return key;
      }),
    add: (value: Record<string, unknown>) =>
      run(() => {
        const record = clone(value);
        const key = record[store.keyPath] as IDBValidKey;
        if (store.records.has(key)) throw new Error("ConstraintError");
        store.records.set(key, record);
        return key;
      }),
    delete: (key: IDBValidKey) =>
      run(() => {
        store.records.delete(key);
      }),
    openCursor: () => {
      const request = createRequest<IDBCursorWithValue | null>();
      const entries = Array.from(store.records.values()).map((value) => clone(value));
      tx.begin();
      const advance = (index: number) => {
        queueMicrotask(() => {
          if (index >= entries.length) {
            request.result = null;
            request.onsuccess?.(new Event("success"));
            tx.end();
            return;
          }
          request.result = {
            get value() {
              return clone(entries[index]);
            },
            update(value: Record<string, unknown>) {
              const record = clone(value);
              const key = record[store.keyPath] as IDBValidKey;
              store.records.set(key, record);
            },
            continue() {
              advance(index + 1);
            },
          } as IDBCursorWithValue;
          request.onsuccess?.(new Event("success"));
        });
      };
      advance(0);
      return request as unknown as IDBRequest<IDBCursorWithValue | null>;
    },
  };
}

function createTransaction(
  data: DatabaseData,
  storeNames: string[],
  onFinish?: (transaction: { forceAbort(error: Error): void }) => void,
  startGate?: Promise<void>,
) {
  let pending = 0;
  let completed = false;
  let aborted = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    onFinish?.(tx);
  };

  const tx = {
    error: null as Error | null,
    oncomplete: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onabort: null as ((event: Event) => void) | null,
    abort() {
      if (completed || aborted) return;
      aborted = true;
      finish();
      tx.onabort?.(new Event("abort"));
    },
    forceAbort(error: Error) {
      if (completed || aborted) return;
      tx.error = error;
      aborted = true;
      finish();
      tx.onabort?.(new Event("abort"));
    },
    begin() {
      pending += 1;
    },
    end() {
      pending -= 1;
      queueMicrotask(() => {
        if (completed || aborted || pending > 0 || tx.error) return;
        completed = true;
        finish();
        tx.oncomplete?.(new Event("complete"));
      });
    },
    run<T>(action: () => T) {
      const request = createRequest<T>();
      tx.begin();
      const execute = () => {
        if (aborted) return;
        try {
          request.result = action();
          request.onsuccess?.(new Event("success"));
        } catch (error) {
          request.error = error as Error;
          tx.error = request.error;
          tx.onerror?.(new Event("error"));
          tx.forceAbort(request.error);
        } finally {
          tx.end();
        }
      };
      if (startGate) void startGate.then(() => queueMicrotask(execute));
      else queueMicrotask(execute);
      return request as unknown as IDBRequest<T>;
    },
    objectStore(name: string) {
      if (!storeNames.includes(name)) throw new Error(`Missing object store: ${name}`);
      const store = data.stores.get(name);
      if (!store) throw new Error(`Missing object store: ${name}`);
      return createObjectStoreHandle(store, tx) as unknown as IDBObjectStore;
    },
  };

  return tx;
}

function createDatabase(data: DatabaseData) {
  let closed = false;
  const activeTransactions = new Set<{ forceAbort(error: Error): void }>();
  let closeNextTransaction = false;
  const forceClose = () => {
    if (closed) return;
    closed = true;
    const error = new DOMException("The database connection was closed.", "AbortError");
    for (const transaction of activeTransactions) transaction.forceAbort(error);
    database.onclose?.(new Event("close"));
  };
  const database = {
    onclose: null as ((event: Event) => void) | null,
    onversionchange: null as ((event: Event) => void) | null,
    close() {
      closed = true;
    },
    __closeNextTransaction() {
      closeNextTransaction = true;
    },
    get objectStoreNames() {
      const names = Array.from(data.stores.keys());
      return {
        contains(name: string) {
          return names.includes(name);
        },
      } as DOMStringList;
    },
    createObjectStore(name: string, options?: IDBObjectStoreParameters) {
      const keyPath = typeof options?.keyPath === "string" ? options.keyPath : "id";
      const store = { keyPath, records: new Map<IDBValidKey, unknown>() };
      data.stores.set(name, store);
      return createObjectStoreHandle(
        store,
        createTransaction(data, [name]),
      ) as unknown as IDBObjectStore;
    },
    transaction(storeNames: string | string[], _mode?: IDBTransactionMode) {
      if (closed) {
        throw new DOMException("The database connection is closed.", "InvalidStateError");
      }
      const transaction = createTransaction(
        data,
        Array.isArray(storeNames) ? storeNames : [storeNames],
        (finished) => activeTransactions.delete(finished),
        nextTransactionGate?.promise,
      );
      nextTransactionGate = undefined;
      activeTransactions.add(transaction);
      if (closeNextTransaction) {
        closeNextTransaction = false;
        queueMicrotask(forceClose);
      }
      return transaction as unknown as IDBTransaction;
    },
  };
  return database;
}

export function installFakeIndexedDb() {
  nextTransactionGate = undefined;
  const databases = new Map<string, DatabaseData>();
  const databaseHandles = new Set<{ __closeNextTransaction(): void }>();
  const original = globalThis.indexedDB;

  const indexedDb = {
    open(name: string, version?: number) {
      const request = {
        ...createRequest<IDBDatabase>(),
        onupgradeneeded: null as ((event: Event) => void) | null,
        onblocked: null as ((event: Event) => void) | null,
        transaction: undefined as IDBTransaction | undefined,
      };
      queueMicrotask(() => {
        const current = databases.get(name);
        const oldVersion = current?.version ?? 0;
        const nextVersion = version ?? current?.version ?? 1;
        const needsUpgrade = !current || nextVersion > current.version;
        const data = current ?? { version: nextVersion, stores: new Map<string, StoreData>() };
        data.version = nextVersion;
        databases.set(name, data);
        const database = createDatabase(data) as IDBDatabase & {
          __closeNextTransaction(): void;
        };
        databaseHandles.add(database);
        request.result = database;
        if (needsUpgrade) {
          request.transaction = createTransaction(
            data,
            Array.from(data.stores.keys()),
          ) as unknown as IDBTransaction;
          const event = new Event("upgradeneeded");
          Object.defineProperty(event, "oldVersion", { value: oldVersion });
          Object.defineProperty(event, "newVersion", { value: nextVersion });
          request.onupgradeneeded?.(event);
        }
        queueMicrotask(() => request.onsuccess?.(new Event("success")));
      });
      return request as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(name: string) {
      const request = createRequest<undefined>();
      queueMicrotask(() => {
        databases.delete(name);
        request.onsuccess?.(new Event("success"));
      });
      return request as unknown as IDBOpenDBRequest;
    },
    __closeNextTransaction() {
      for (const database of databaseHandles) database.__closeNextTransaction();
    },
  } as unknown as IDBFactory;

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDb,
  });

  return () => {
    databaseHandles.clear();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: original,
    });
  };
}

/** Test-only seam: hold the first request of the next transaction. */
export function deferNextFakeIndexedDbTransaction() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  nextTransactionGate = { promise, release };
  return { release };
}

/** Test-only seam: force the next active fake transaction to abort as AbortError. */
export function closeNextFakeIndexedDbTransaction() {
  (
    globalThis.indexedDB as IDBFactory & { __closeNextTransaction?: () => void }
  ).__closeNextTransaction?.();
}
