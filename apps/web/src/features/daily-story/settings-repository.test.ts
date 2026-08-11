import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  closeNextFakeIndexedDbTransaction,
  installFakeIndexedDb,
} from "@/lib/practice/test/fakeIndexedDb";
import {
  __closeDailyStorageConnectionForTests,
  __resetDailyStorageForTests,
  SessionConflictError,
  DailyStorageError,
  clearProvider,
  acquireStoryLease,
  claimStoryLease,
  deleteStorySession,
  exportStorySessions,
  importStorySessions,
  listStorySessions,
  readProviderSettings,
  readStorySession,
  releaseStoryLease,
  saveAsrDirectPreference,
  saveProvider,
  writeStorySession,
} from "./settings-repository";

let restore: () => void;

async function seedRawSettings(record: Record<string, unknown>) {
  const request = indexedDB.open("kotoba-loop-settings", 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("providerSettings", "readwrite");
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.objectStore("providerSettings").put(record);
  });
}

async function readRawSettings() {
  const request = indexedDB.open("kotoba-loop-settings", 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const transaction = db.transaction("providerSettings", "readonly");
    const read = transaction.objectStore("providerSettings").get("current");
    read.onsuccess = () => {
      db.close();
      resolve(read.result as Record<string, unknown> | undefined);
    };
    read.onerror = () => {
      db.close();
      reject(read.error);
    };
  });
}

async function mutateRawStore(
  storeName: "storySessions" | "storyLeases",
  mutate: (store: IDBObjectStore) => void,
) {
  const request = indexedDB.open("kotoba-loop-settings", 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
    mutate(transaction.objectStore(storeName));
  });
}

async function readRawStore(storeName: "storySessions" | "storyLeases") {
  const request = indexedDB.open("kotoba-loop-settings", 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const read = transaction.objectStore(storeName).getAll();
    read.onsuccess = () => {
      db.close();
      resolve(read.result as Record<string, unknown>[]);
    };
    read.onerror = () => {
      db.close();
      reject(read.error);
    };
  });
}

async function clearRawStore(storeName: "storySessions" | "storyLeases") {
  await mutateRawStore(storeName, (store) => {
    const read = store.getAll();
    read.onsuccess = () => {
      for (const record of read.result as Array<{ id: string }>) store.delete(record.id);
    };
  });
}

function exportFixture(id: string, text = "I stayed home.") {
  return JSON.stringify({
    format: "kotoba-daily-story",
    version: 1,
    sessions: [
      {
        id,
        updatedAt: "2026-08-10T00:00:00.000Z",
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [
          { id: `${id}-ai`, role: "assistant", text: "How was your day?" },
          { id: `${id}-user`, role: "user", text, source: "typed" },
        ],
      },
    ],
  });
}

beforeAll(() => {
  restore = installFakeIndexedDb();
});

afterAll(() => restore());

describe("Daily Story IndexedDB", () => {
  test("persists config only in dedicated settings store and clears one provider", async () => {
    const saved = await saveProvider("chat", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret-never-in-session",
      model: "chat-model",
    });
    expect(saved.revision).toBe(1);
    expect((await readProviderSettings()).chat?.apiKey).toBe("secret-never-in-session");

    const cleared = await clearProvider("chat");
    expect(cleared.revision).toBe(2);
    expect((await readProviderSettings()).chat).toBeUndefined();
  });

  test("loads legacy settings with ASR direct opt-in defaulting to false, then persists opt-in locally", async () => {
    await seedRawSettings({
      id: "current",
      schemaVersion: 1,
      revision: 4,
      updatedAt: "2026-08-10T00:00:00.000Z",
      asr: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "dashscope-key",
        model: "fun-asr-realtime",
        responseFormat: "json",
      },
    });

    const loaded = await readProviderSettings();
    expect(loaded.local?.asrDirect ?? false).toBe(false);

    const saved = await saveAsrDirectPreference(true);
    expect(saved.local?.asrDirect).toBe(true);
    expect((await readProviderSettings()).local?.asrDirect).toBe(true);
    expect(await readRawSettings()).toMatchObject({
      local: { asrDirect: true },
    });
  });

  test("recovers when the cached IndexedDB connection has gone stale", async () => {
    const before = await readProviderSettings();
    await __closeDailyStorageConnectionForTests();

    const after = await saveProvider("chat", {
      baseUrl: "https://recovered.example.com/v1",
      apiKey: "recovered-key",
      model: "recovered-model",
    });

    expect(after.revision).toBe(before.revision + 1);
    expect((await readProviderSettings()).chat?.model).toBe("recovered-model");
  });

  test("retries an AbortError from a closed active transaction without duplicate writes", async () => {
    const before = await readProviderSettings();
    closeNextFakeIndexedDbTransaction();

    const after = await saveProvider("chat", {
      baseUrl: "https://abort-recovered.example.com/v1",
      apiKey: "abort-recovered-key",
      model: "abort-recovered-model",
    });

    expect(after.revision).toBe(before.revision + 1);
    expect(await readRawSettings()).toMatchObject({
      revision: before.revision + 1,
      chat: { model: "abort-recovered-model" },
    });

    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    closeNextFakeIndexedDbTransaction();
    await expect(importStorySessions(exportFixture("abort-import"))).resolves.toEqual({
      imported: 1,
      migratedLegacy: false,
    });
    expect(
      (await listStorySessions()).filter((session) => session.id === "abort-import"),
    ).toHaveLength(1);
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
  });

  test("uses a storage-specific message for unavailable IndexedDB", async () => {
    await __resetDailyStorageForTests();
    const indexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      await expect(readProviderSettings()).rejects.toMatchObject({
        name: "DailyStorageError",
        message: "当前浏览器无法访问本机存储。请允许此网站使用 IndexedDB 后重试。",
      } satisfies Partial<DailyStorageError>);
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDb });
    }
  });

  test("normalizes legacy endpoint and infers provider preset on save", async () => {
    const saved = await saveProvider("chat", {
      baseUrl: "https://api.deepseek.com/",
      apiKey: "deepseek-key",
      model: "deepseek-v4-flash",
      preset: "openai-compatible",
    });
    expect(saved.chat?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.chat?.preset).toBe("deepseek");
  });

  test("rejects known providers that do not support the selected capability", async () => {
    expect(() =>
      saveProvider("asr", {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-key",
        model: "deepseek-v4-flash",
      }),
    ).toThrow();
    expect(() =>
      saveProvider("tts", {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "dashscope-key",
        model: "qwen-plus",
        voice: "alloy",
      }),
    ).toThrow();
  });

  test("does not persist a preset for an unknown custom endpoint", async () => {
    const saved = await saveProvider("chat", {
      baseUrl: "https://provider.example.com/v1",
      apiKey: "custom-key",
      model: "custom-model",
      preset: "openai-compatible",
    });

    expect(saved.chat).not.toHaveProperty("preset");
    expect((await readProviderSettings()).chat).not.toHaveProperty("preset");
  });

  test("drops stale raw presets for custom endpoints and infers known endpoints", async () => {
    await seedRawSettings({
      id: "current",
      schemaVersion: 1,
      revision: 9,
      updatedAt: "2024-01-01T00:00:00.000Z",
      chat: {
        baseUrl: "https://provider.example.com/custom",
        apiKey: "custom-key",
        model: "custom-model",
        preset: "openai-compatible",
      },
      asr: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "deepseek-key",
        model: "deepseek-model",
        preset: "openai-compatible",
        responseFormat: "json",
      },
    });

    const settings = await readProviderSettings();

    expect(settings.chat).toEqual({
      baseUrl: "https://provider.example.com/custom/v1",
      apiKey: "custom-key",
      model: "custom-model",
    });
    expect(settings.chat).not.toHaveProperty("preset");
    expect(settings.asr?.preset).toBe("deepseek");

    expect(await readRawSettings()).toEqual({
      id: "current",
      schemaVersion: 1,
      revision: 9,
      updatedAt: "2024-01-01T00:00:00.000Z",
      chat: {
        baseUrl: "https://provider.example.com/custom/v1",
        apiKey: "custom-key",
        model: "custom-model",
      },
      asr: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-key",
        model: "deepseek-model",
        preset: "deepseek",
        responseFormat: "json",
      },
    });
  });

  test("uses revision CAS for stable story snapshots", async () => {
    const first = await writeStorySession(
      {
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [{ id: "ai-1", role: "assistant", text: "How was your day?" }],
      },
      null,
    );
    expect(first.revision).toBe(1);
    expect((await readStorySession())?.messages[0]?.text).toBe("How was your day?");

    await expect(
      writeStorySession(
        {
          phase: "chatting",
          storyZh: "旧标签页",
          messages: [],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);
  });

  test("preserves session conflicts for asynchronous write and delete checks", async () => {
    const saved = await writeStorySession(
      "conversation-conflict",
      {
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [],
      },
      null,
    );

    await expect(
      writeStorySession(
        "conversation-conflict",
        {
          phase: "chatting",
          storyZh: "旧标签页",
          messages: [],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);

    await expect(deleteStorySession("conversation-conflict", null)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    expect((await readStorySession("conversation-conflict"))?.revision).toBe(saved.revision);
    await deleteStorySession("conversation-conflict", saved.revision);
  });

  test("migrates the legacy current session and keeps conversations separate", async () => {
    const migrated = await listStorySessions();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.id).not.toBe("current");
    expect((await readStorySession(migrated[0]!.id))?.storyZh).toBe("今天下雨");

    await writeStorySession(
      "conversation-two",
      {
        phase: "chatting",
        storyZh: "第二个故事",
        messages: [{ id: "ai-2", role: "assistant", text: "Tell me more." }],
      },
      null,
    );
    expect((await listStorySessions()).map((item) => item.id)).toContain("conversation-two");
    expect((await readStorySession(migrated[0]!.id))?.storyZh).toBe("今天下雨");
  });

  test("leases are isolated per conversation", async () => {
    expect(await acquireStoryLease("conversation-a", "owner-a")).toBe(true);
    expect(await acquireStoryLease("conversation-b", "owner-b")).toBe(true);
    expect(await acquireStoryLease("conversation-a", "owner-b")).toBe(false);
    expect(await claimStoryLease("conversation-a", "owner-b")).toBe(true);
    expect(await acquireStoryLease("conversation-a", "owner-a")).toBe(false);
    await releaseStoryLease("conversation-a", "owner-a");
    await releaseStoryLease("conversation-a", "owner-b");
    expect(await acquireStoryLease("conversation-a", "owner-a")).toBe(true);
    await releaseStoryLease("conversation-a", "owner-b");
    await releaseStoryLease("conversation-b", "owner-b");
  });

  test("round-trips projected sessions without secrets or revision", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    const saved = await writeStorySession(
      "conversation-roundtrip",
      {
        phase: "review",
        storyZh: "今天下雨",
        messages: [
          { id: "ai-roundtrip", role: "assistant", text: "How was your day?" },
          {
            id: "user-roundtrip",
            role: "user",
            source: "typed",
            text: "I stayed home.",
          },
        ],
        review: {
          suggestions: [
            {
              sourceTurnId: "user-roundtrip",
              original: "I stayed home.",
              improved: "I stayed at home.",
              category: "naturalness",
              explanationZh: "这里更自然。",
            },
          ],
        },
      },
      null,
    );
    const exported = JSON.parse(await exportStorySessions()) as Record<string, unknown>;
    const exportedSession = (exported["sessions"] as Array<Record<string, unknown>>)[0]!;
    expect(exported).toEqual({
      format: "kotoba-daily-story",
      version: 1,
      sessions: [
        {
          id: "conversation-roundtrip",
          updatedAt: saved.updatedAt,
          phase: "review",
          storyZh: "今天下雨",
          messages: [
            { id: "ai-roundtrip", role: "assistant", text: "How was your day?" },
            {
              id: "user-roundtrip",
              role: "user",
              text: "I stayed home.",
              source: "typed",
            },
          ],
          review: {
            suggestions: [
              {
                sourceTurnId: "user-roundtrip",
                original: "I stayed home.",
                improved: "I stayed at home.",
                category: "naturalness",
                explanationZh: "这里更自然。",
              },
            ],
          },
        },
      ],
    });
    expect(exportedSession).not.toHaveProperty("revision");
    expect(await exportStorySessions()).not.toContain("apiKey");
    expect(await exportStorySessions()).not.toContain("audio");
    expect(await exportStorySessions()).not.toContain("asrDirect");

    await deleteStorySession("conversation-roundtrip", saved.revision);
    await importStorySessions(JSON.stringify(exported));
    const restored = await readStorySession("conversation-roundtrip");
    expect(restored?.revision).toBe(1);
    expect(restored?.updatedAt).toBe(saved.updatedAt);
    expect(restored?.review?.suggestions[0]?.category).toBe("naturalness");
  });

  test("refuses to export a legacy record that cannot pass the import schema", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    await mutateRawStore("storySessions", (store) => {
      store.put({
        id: "conversation-legacy",
        schemaVersion: 1,
        revision: 3,
        updatedAt: "2026-08-10T00:00:00.000Z",
        phase: "chatting",
        storyZh: "旧对话",
        // The storage schema historically allowed this ID, while the
        // transfer schema rejects it to keep imported IDs safe and stable.
        messages: [{ id: "legacy message", role: "assistant", text: "Tell me more." }],
      });
    });

    await expect(exportStorySessions()).rejects.toMatchObject({ name: "StoryImportError" });
    expect(await readRawStore("storySessions")).toHaveLength(1);
  });

  test("rejects invalid, duplicate, current, and sensitive-field imports", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    const cases: Array<[string, () => string]> = [
      ["current", () => exportFixture("current")],
      ["unsafe id", () => exportFixture("unsafe id")],
      [
        "unknown field",
        () => {
          const value = JSON.parse(exportFixture("unknown-field")) as {
            sessions: Array<Record<string, unknown>>;
          };
          value.sessions[0]!["revision"] = 9;
          value.sessions[0]!["apiKey"] = "secret";
          value.sessions[0]!["audio"] = { blob: "no" };
          value.sessions[0]!["lease"] = { ownerId: "no" };
          return JSON.stringify(value);
        },
      ],
      [
        "duplicate message id",
        () => {
          const value = JSON.parse(exportFixture("duplicate-message")) as {
            sessions: Array<{ messages: Array<{ id: string }> }>;
          };
          value.sessions[0]!.messages[1]!.id = value.sessions[0]!.messages[0]!.id;
          return JSON.stringify(value);
        },
      ],
      [
        "pending id collision",
        () => {
          const value = JSON.parse(exportFixture("pending-collision")) as {
            sessions: Array<{ messages: Array<{ id: string }>; pendingAsrTranscript?: unknown }>;
          };
          value.sessions[0]!.pendingAsrTranscript = {
            id: value.sessions[0]!.messages[0]!.id,
            text: "pending",
          };
          return JSON.stringify(value);
        },
      ],
      [
        "review source semantics",
        () => {
          const value = JSON.parse(exportFixture("bad-review")) as {
            sessions: Array<{ review?: unknown }>;
          };
          value.sessions[0]!.review = {
            suggestions: [
              {
                sourceTurnId: "bad-source",
                original: "not the user text",
                improved: "new text",
                category: "grammar",
                explanationZh: "说明",
              },
            ],
          };
          return JSON.stringify(value);
        },
      ],
    ];
    for (const [label, json] of cases) {
      await expect(importStorySessions(json()), label).rejects.toBeInstanceOf(Error);
    }

    const duplicate = JSON.parse(exportFixture("duplicate-session")) as {
      sessions: unknown[];
    };
    duplicate.sessions.push(duplicate.sessions[0]);
    await expect(importStorySessions(JSON.stringify(duplicate))).rejects.toBeInstanceOf(Error);
    expect(await readRawStore("storySessions")).toHaveLength(0);
  });

  test("enforces transfer byte, session, and message count limits", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    const tooLarge = JSON.stringify({
      format: "kotoba-daily-story",
      version: 1,
      sessions: [],
      padding: "x".repeat(10 * 1024 * 1024),
    });
    await expect(importStorySessions(tooLarge)).rejects.toBeInstanceOf(Error);

    const tooManySessions = JSON.parse(exportFixture("many-sessions")) as {
      sessions: Array<Record<string, unknown>>;
    };
    tooManySessions.sessions = Array.from({ length: 201 }, (_, index) => ({
      ...(tooManySessions.sessions[0] as Record<string, unknown>),
      id: `many-${index}`,
    }));
    await expect(importStorySessions(JSON.stringify(tooManySessions))).rejects.toBeInstanceOf(
      Error,
    );

    const tooManyMessages = JSON.parse(exportFixture("many-messages")) as {
      sessions: Array<{ messages: Array<Record<string, unknown>> }>;
    };
    tooManyMessages.sessions[0]!.messages = Array.from({ length: 41 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      text: "A message.",
    }));
    await expect(importStorySessions(JSON.stringify(tooManyMessages))).rejects.toBeInstanceOf(
      Error,
    );
    expect(await readRawStore("storySessions")).toHaveLength(0);
  });

  test("rejects an existing ID as one file and keeps all records unchanged", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    await writeStorySession(
      "conversation-conflict",
      { phase: "chatting", storyZh: "已有故事", messages: [] },
      null,
    );
    const before = await readRawStore("storySessions");
    const value = JSON.parse(exportFixture("conversation-conflict")) as {
      sessions: Array<Record<string, unknown>>;
    };
    value.sessions.push({
      ...(value.sessions[0] as Record<string, unknown>),
      id: "conversation-fresh",
    });
    await expect(importStorySessions(JSON.stringify(value))).rejects.toBeInstanceOf(Error);
    expect(await readRawStore("storySessions")).toEqual(before);
  });

  test("does not migrate legacy current on preflight failure, then migrates it on success", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    await writeStorySession(
      "conversation-existing",
      { phase: "chatting", storyZh: "已有故事", messages: [] },
      null,
    );
    await mutateRawStore("storySessions", (store) => {
      store.put({
        id: "current",
        schemaVersion: 1,
        revision: 7,
        updatedAt: "2025-01-01T00:00:00.000Z",
        phase: "transcriptReady",
        storyZh: "旧故事",
        messages: [{ id: "old-ai", role: "assistant", text: "Tell me more." }],
        pendingAsrTranscript: { id: "old-asr", text: "I went home." },
      });
    });
    await mutateRawStore("storyLeases", (store) => {
      store.put({ id: "current", ownerId: "old-tab", expiresAt: Date.now() + 10_000 });
    });

    const beforeSessions = await readRawStore("storySessions");
    const beforeLeases = await readRawStore("storyLeases");
    await expect(
      importStorySessions(exportFixture("conversation-existing")),
    ).rejects.toBeInstanceOf(Error);
    expect(await readRawStore("storySessions")).toEqual(beforeSessions);
    expect(await readRawStore("storyLeases")).toEqual(beforeLeases);

    await importStorySessions(exportFixture("conversation-imported"));
    expect(await readStorySession("current")).toBeNull();
    expect((await readStorySession("conversation-imported"))?.revision).toBe(1);
    const migrated = (await readRawStore("storySessions")).find(
      (record) =>
        record["id"] !== "conversation-existing" && record["id"] !== "conversation-imported",
    );
    expect(migrated).toMatchObject({
      revision: 7,
      updatedAt: "2025-01-01T00:00:00.000Z",
      storyZh: "旧故事",
    });
    expect((await readRawStore("storyLeases")).find((record) => record["id"] === "current")).toBe(
      undefined,
    );
    expect(
      (await readRawStore("storyLeases")).find((record) => record["ownerId"] === "old-tab"),
    ).toMatchObject({ ownerId: "old-tab" });
  });
});
