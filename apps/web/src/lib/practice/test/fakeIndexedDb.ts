type StoreData = {
  keyPath: string;
  records: Map<IDBValidKey, unknown>;
};

type DatabaseData = {
  version: number;
  stores: Map<string, StoreData>;
};

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
    get: (key: IDBValidKey) => run(() => clone(store.records.get(key))),
    put: (value: Record<string, unknown>) =>
      run(() => {
        const record = clone(value);
        const key = record[store.keyPath] as IDBValidKey;
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

function createTransaction(data: DatabaseData, storeNames: string[]) {
  let pending = 0;
  let completed = false;

  const tx = {
    error: null as Error | null,
    oncomplete: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onabort: null as ((event: Event) => void) | null,
    begin() {
      pending += 1;
    },
    end() {
      pending -= 1;
      queueMicrotask(() => {
        if (completed || pending > 0 || tx.error) return;
        completed = true;
        tx.oncomplete?.(new Event("complete"));
      });
    },
    run<T>(action: () => T) {
      const request = createRequest<T>();
      tx.begin();
      queueMicrotask(() => {
        try {
          request.result = action();
          request.onsuccess?.(new Event("success"));
        } catch (error) {
          request.error = error as Error;
          tx.error = request.error;
          tx.onerror?.(new Event("error"));
          tx.onabort?.(new Event("abort"));
        } finally {
          tx.end();
        }
      });
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
  return {
    onversionchange: null as ((event: Event) => void) | null,
    close() {},
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
      return createTransaction(
        data,
        Array.isArray(storeNames) ? storeNames : [storeNames],
      ) as unknown as IDBTransaction;
    },
  };
}

export function installFakeIndexedDb() {
  const databases = new Map<string, DatabaseData>();
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
        const nextVersion = version ?? current?.version ?? 1;
        const needsUpgrade = !current || nextVersion > current.version;
        const data = current ?? { version: nextVersion, stores: new Map<string, StoreData>() };
        data.version = nextVersion;
        databases.set(name, data);
        request.result = createDatabase(data) as IDBDatabase;
        if (needsUpgrade) request.onupgradeneeded?.(new Event("upgradeneeded"));
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
  } as IDBFactory;

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDb,
  });

  return () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: original,
    });
  };
}
