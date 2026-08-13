import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  closeNextFakeIndexedDbTransaction,
  deferNextFakeIndexedDbTransaction,
  installFakeIndexedDb,
} from "@/lib/practice/test/fakeIndexedDb";
import {
  SessionConflictError,
  DailyStorageError,
  clearProvider,
  acquireStoryLease,
  claimStoryLease,
  claimStoryLeaseToken,
  deleteStorySession,
  ensureDailyStorage,
  exportStorySessions,
  importStorySessions,
  listStorySessions,
  readProviderSettings,
  readStorySession,
  saveAsrDirectPreference,
  saveProvider,
  writeStorySession,
} from "./settings-repository";
import {
  deleteDailyStoryReview,
  releaseStoryLeaseToken,
  renewStoryLeaseToken,
  writeDailyStoryReview,
} from "./persistence";
import {
  __closeDailyStorageConnectionForTests,
  __resetDailyStorageForTests,
} from "./persistence/testing";

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

beforeEach(async () => {
  await __resetDailyStorageForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("kotoba-loop-settings");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("kotoba-daily-story-review-v2");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await __resetDailyStorageForTests();
  await ensureDailyStorage();
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

  test("rejects a stale owner delete and allows the current owner to delete", async () => {
    const saved = await writeStorySession(
      "conversation-owner-delete",
      {
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [],
      },
      null,
    );
    const tokenA = await claimStoryLeaseToken("conversation-owner-delete", "owner-a");
    expect(tokenA).toBeTruthy();
    await releaseStoryLeaseToken("conversation-owner-delete", "owner-a", tokenA!);
    const tokenB = await claimStoryLeaseToken("conversation-owner-delete", "owner-b");
    expect(tokenB).toBeTruthy();

    await expect(
      deleteStorySession("conversation-owner-delete", saved.revision, "owner-a", tokenA!),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(readStorySession("conversation-owner-delete")).resolves.toMatchObject({
      revision: saved.revision,
    });

    await expect(
      deleteStorySession("conversation-owner-delete", saved.revision, "owner-b", tokenB!),
    ).resolves.toBeUndefined();
    await expect(
      deleteStorySession("conversation-owner-delete", saved.revision, "owner-b", tokenB!),
    ).resolves.toBeUndefined();
    await expect(readStorySession("conversation-owner-delete")).resolves.toBeNull();
    await releaseStoryLeaseToken("conversation-owner-delete", "owner-b", tokenB!);
  });

  test("fails closed when a lease owner omits the fencing token", async () => {
    const conversationId = "conversation-missing-lease-token";
    const saved = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "原始故事", messages: [] },
      null,
    );
    const token = await claimStoryLeaseToken(conversationId, "owner");
    expect(token).toBeTruthy();

    const ownerOnlyWrite = writeStorySession as unknown as (...args: unknown[]) => Promise<unknown>;
    const ownerOnlyDelete = deleteStorySession as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await expect(
      ownerOnlyWrite(
        conversationId,
        { phase: "chatting", storyZh: "不应写入", messages: [] },
        saved.revision,
        "owner",
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: saved.revision,
      storyZh: "原始故事",
    });

    await expect(ownerOnlyDelete(conversationId, saved.revision, "owner")).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: saved.revision,
      storyZh: "原始故事",
    });

    await releaseStoryLeaseToken(conversationId, "owner", token!);
  });

  test("fences stale token writes and deletes after lease handoff", async () => {
    const saved = await writeStorySession(
      "conversation-lease-token-handoff",
      {
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [],
      },
      null,
    );
    const tokenT1 = await claimStoryLeaseToken("conversation-lease-token-handoff", "owner");
    expect(tokenT1).toBeTruthy();
    await releaseStoryLeaseToken("conversation-lease-token-handoff", "owner", tokenT1!);
    const tokenT2 = await claimStoryLeaseToken("conversation-lease-token-handoff", "owner");
    expect(tokenT2).toBeTruthy();
    expect(tokenT2).not.toBe(tokenT1);

    await expect(
      writeStorySession(
        "conversation-lease-token-handoff",
        { phase: "chatting", storyZh: "T1 stale write", messages: [] },
        saved.revision,
        "owner",
        tokenT1!,
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(
      deleteStorySession("conversation-lease-token-handoff", saved.revision, "owner", tokenT1!),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(readStorySession("conversation-lease-token-handoff")).resolves.toMatchObject({
      revision: saved.revision,
      storyZh: "今天下雨",
    });

    const current = await writeStorySession(
      "conversation-lease-token-handoff",
      { phase: "chatting", storyZh: "T2 current write", messages: [] },
      saved.revision,
      "owner",
      tokenT2!,
    );
    expect(current.revision).toBe(saved.revision + 1);
    await deleteStorySession(
      "conversation-lease-token-handoff",
      current.revision,
      "owner",
      tokenT2!,
    );
    await releaseStoryLeaseToken("conversation-lease-token-handoff", "owner", tokenT2!);
  });

  test("rejects writes and deletes after the owner's lease expires", async () => {
    const saved = await writeStorySession(
      "conversation-expired-owner",
      {
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [],
      },
      null,
    );
    const token = await claimStoryLeaseToken("conversation-expired-owner", "owner-a");
    expect(token).toBeTruthy();
    await mutateRawStore("storyLeases", (store) => {
      store.put({
        id: "conversation-expired-owner",
        ownerId: "owner-a",
        claimToken: token,
        expiresAt: Date.now() - 1,
      });
    });

    await expect(
      writeStorySession(
        "conversation-expired-owner",
        { phase: "chatting", storyZh: "过期写入", messages: [] },
        saved.revision,
        "owner-a",
        token!,
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(
      deleteStorySession("conversation-expired-owner", saved.revision, "owner-a", token!),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(readStorySession("conversation-expired-owner")).resolves.toMatchObject({
      revision: saved.revision,
    });
    await deleteStorySession("conversation-expired-owner", saved.revision);
  });

  test("migrates the legacy current session and keeps conversations separate", async () => {
    await ensureDailyStorage();
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    await mutateRawStore("storySessions", (store) => {
      store.put({
        id: "current",
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
        phase: "chatting",
        storyZh: "今天下雨",
        messages: [{ id: "legacy-ai", role: "assistant", text: "How was your day?" }],
      });
    });
    await mutateRawStore("storyLeases", (store) => {
      store.put({ id: "current", ownerId: "legacy-owner", expiresAt: Date.now() + 10_000 });
    });
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
    const tokenA = await claimStoryLeaseToken("conversation-a", "owner-a");
    const tokenB = await claimStoryLeaseToken("conversation-b", "owner-b");
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(await acquireStoryLease("conversation-a", "owner-b")).toBe(false);
    expect(await claimStoryLease("conversation-a", "owner-b")).toBe(false);
    await releaseStoryLeaseToken("conversation-a", "owner-a", tokenA!);
    const replacement = await claimStoryLeaseToken("conversation-a", "owner-b");
    expect(replacement).toBeTruthy();
    await releaseStoryLeaseToken("conversation-a", "owner-b", replacement!);
    await releaseStoryLeaseToken("conversation-b", "owner-b", tokenB!);
  });

  test("renew preserves the fencing token and only extends its expiry", async () => {
    const conversationId = "conversation-renew-stable-token";
    const token = await claimStoryLeaseToken(conversationId, "owner", 1);
    expect(token).toBeTruthy();
    const before = (await readRawStore("storyLeases")).find(
      (record) => record["id"] === conversationId,
    );
    expect(await renewStoryLeaseToken(conversationId, "owner", token!)).toBe(true);
    expect(await renewStoryLeaseToken(conversationId, "owner", token!)).toBe(true);
    const after = (await readRawStore("storyLeases")).find(
      (record) => record["id"] === conversationId,
    );
    expect(after?.["claimToken"]).toBe(token);
    expect(after?.["claimSequence"]).toBe(1);
    expect(Number(after?.["expiresAt"] ?? 0)).toBeGreaterThanOrEqual(
      Number(before?.["expiresAt"] ?? 0),
    );
    await releaseStoryLeaseToken(conversationId, "owner", token!);
  });

  test("a mutation captured before heartbeat still succeeds with the same token", async () => {
    const conversationId = "conversation-renew-mutation";
    const saved = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "原始故事", messages: [] },
      null,
    );
    const token = await claimStoryLeaseToken(conversationId, "owner", 1);
    expect(token).toBeTruthy();
    expect(await renewStoryLeaseToken(conversationId, "owner", token!)).toBe(true);
    const updated = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "heartbeat 后仍可写入", messages: [] },
      saved.revision,
      "owner",
      token!,
    );
    expect(updated.revision).toBe(saved.revision + 1);
    await releaseStoryLeaseToken(conversationId, "owner", token!);
  });

  test("renew rejects a replaced or expired generation", async () => {
    const conversationId = "conversation-renew-fenced";
    const tokenT1 = await claimStoryLeaseToken(conversationId, "owner", 1);
    expect(tokenT1).toBeTruthy();
    await releaseStoryLeaseToken(conversationId, "owner", tokenT1!);
    const tokenT2 = await claimStoryLeaseToken(conversationId, "owner", 2);
    expect(tokenT2).toBeTruthy();
    await releaseStoryLeaseToken(conversationId, "owner", tokenT1!);
    expect(await renewStoryLeaseToken(conversationId, "owner", tokenT2!)).toBe(true);
    expect(await renewStoryLeaseToken(conversationId, "owner", tokenT1!)).toBe(false);
    await mutateRawStore("storyLeases", (store) => {
      store.put({
        id: conversationId,
        ownerId: "owner",
        claimToken: tokenT2,
        claimSequence: 2,
        expiresAt: Date.now() - 1,
      });
    });
    expect(await renewStoryLeaseToken(conversationId, "owner", tokenT2!)).toBe(false);
  });

  test("same-millisecond claim sequence keeps the newer load lease", async () => {
    const conversationId = "conversation-same-millisecond-claims";
    const newer = await claimStoryLeaseToken(conversationId, "owner", 2);
    expect(newer).toBeTruthy();
    const older = await claimStoryLeaseToken(conversationId, "owner", 1);
    expect(older).toBeNull();
    const lease = (await readRawStore("storyLeases")).find(
      (record) => record["id"] === conversationId,
    );
    expect(lease).toMatchObject({ ownerId: "owner", claimToken: newer, claimSequence: 2 });
    await releaseStoryLeaseToken(conversationId, "owner", newer!);
  });

  test("rejects a late lease claim with an older local sequence", async () => {
    const newer = await claimStoryLeaseToken("conversation-lease-race", "newer", 2_000);
    expect(newer).toBeTruthy();
    await expect(
      claimStoryLeaseToken("conversation-lease-race", "older", 1_000),
    ).resolves.toBeNull();
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
          score: 88,
          comment: "继续保持。",
          rubric: null,
          suggestions: [
            {
              sourceTurnId: "user-roundtrip",
              original: "I stayed home.",
              diff: [
                ["=", "I stayed"],
                ["-", " home."],
              ],
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
      version: 2,
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
            score: 88,
            comment: "继续保持。",
            rubric: null,
            suggestions: [
              {
                sourceTurnId: "user-roundtrip",
                original: "I stayed home.",
                diff: [
                  ["=", "I stayed"],
                  ["-", " home."],
                ],
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
    expect(restored?.review?.score).toBe(88);
    expect(restored?.review?.comment).toBe("继续保持。");
    expect(restored?.review?.suggestions[0]?.category).toBe("naturalness");
    expect(restored?.review?.suggestions[0]?.diff).toEqual([
      ["=", "I stayed"],
      ["-", " home."],
    ]);
  });

  test("imports legacy v1 exports and carries forward an unscored review", async () => {
    await clearRawStore("storySessions");
    await clearRawStore("storyLeases");
    const legacy = JSON.parse(exportFixture("legacy-v1")) as {
      sessions: Array<Record<string, unknown>>;
    };
    legacy.sessions[0]!["phase"] = "review";
    legacy.sessions[0]!["review"] = {
      suggestions: [
        {
          sourceTurnId: "legacy-v1-user",
          original: "I stayed home.",
          improved: "I stayed at home.",
          category: "naturalness",
          explanationZh: "这里更自然。",
        },
      ],
    };

    await expect(importStorySessions(JSON.stringify(legacy))).resolves.toEqual({
      imported: 1,
      migratedLegacy: false,
    });
    await expect(readStorySession("legacy-v1")).resolves.toMatchObject({
      phase: "review",
      review: {
        score: null,
        comment: null,
        rubric: null,
        suggestions: [{ sourceTurnId: "legacy-v1-user" }],
      },
    });
    await expect(exportStorySessions()).resolves.toContain('"version":2');
    await deleteStorySession("legacy-v1", 1);
  });

  test("does not merge a stale sidecar into a reused session id", async () => {
    await clearRawStore("storySessions");
    const first = await writeStorySession(
      "reused-session",
      {
        phase: "review",
        storyZh: "旧故事",
        messages: [{ id: "u1", role: "user", source: "typed", text: "Old." }],
        review: {
          score: null,
          comment: null,
          rubric: null,
          suggestions: [],
        },
      },
      null,
    );
    await deleteStorySession("reused-session", first.revision);
    await writeDailyStoryReview("reused-session", {
      score: 99,
      comment: "stale",
      rubric: null,
      sessionRevision: 1,
      sessionInstanceId: "old-instance",
    });
    const second = await writeStorySession(
      "reused-session",
      {
        phase: "review",
        storyZh: "新故事",
        messages: [{ id: "u2", role: "user", source: "typed", text: "New." }],
        review: { suggestions: [] },
      },
      null,
    );
    expect((await readStorySession("reused-session"))?.review?.score).toBe(null);
    expect(await exportStorySessions()).not.toContain("stale");
    expect(second.revision).toBe(1);
  });

  test("stale sidecar cleanup cannot delete a newer session review", async () => {
    await clearRawStore("storySessions");
    const first = await writeStorySession(
      "sidecar-generation-race",
      {
        phase: "review",
        storyZh: "旧故事",
        messages: [{ id: "old", role: "user", source: "typed", text: "Old." }],
        review: { score: null, comment: null, rubric: null, suggestions: [] },
      },
      null,
    );
    const firstIdentity = first.sessionInstanceId;
    await clearRawStore("storySessions");
    const second = await writeStorySession(
      "sidecar-generation-race",
      {
        phase: "review",
        storyZh: "新故事",
        messages: [{ id: "new", role: "user", source: "typed", text: "New." }],
        review: { score: 91, comment: "保留", rubric: null, suggestions: [] },
      },
      null,
    );
    expect(second.sessionInstanceId).not.toBe(firstIdentity);

    await deleteDailyStoryReview("sidecar-generation-race", first.revision, firstIdentity);

    await expect(readStorySession("sidecar-generation-race")).resolves.toMatchObject({
      sessionInstanceId: second.sessionInstanceId,
      review: { score: 91, comment: "保留" },
    });
  });

  test("a stale same-generation sidecar write cannot overwrite a newer revision", async () => {
    const conversationId = "sidecar-revision-write-race";
    const seed = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "故事",
        messages: [{ id: "u1", role: "user", source: "typed", text: "Hello." }],
        review: { suggestions: [] },
      },
      null,
    );

    const gate = deferNextFakeIndexedDbTransaction();
    const staleWrite = writeDailyStoryReview(conversationId, {
      score: 55,
      comment: "旧版本",
      rubric: null,
      sessionRevision: seed.revision,
      ...(seed.sessionInstanceId ? { sessionInstanceId: seed.sessionInstanceId } : {}),
    });
    await Promise.resolve();

    await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "故事",
        messages: [{ id: "u1", role: "user", source: "typed", text: "Hello." }],
        review: { score: 88, comment: "新版本", rubric: null, suggestions: [] },
      },
      seed.revision,
    );
    gate.release();
    await staleWrite;

    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: seed.revision + 1,
      review: { score: 88, comment: "新版本", rubric: null },
    });
  });

  test("a stale old-session sidecar write cannot overwrite a reused session id", async () => {
    const conversationId = "sidecar-session-reuse-write-race";
    const old = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "旧故事",
        messages: [{ id: "old", role: "user", source: "typed", text: "Old." }],
        review: { score: 31, comment: "旧代", rubric: null, suggestions: [] },
      },
      null,
    );
    await deleteStorySession(conversationId, old.revision);

    const gate = deferNextFakeIndexedDbTransaction();
    const staleWrite = writeDailyStoryReview(conversationId, {
      score: 31,
      comment: "迟到旧代",
      rubric: null,
      sessionRevision: old.revision,
      ...(old.sessionInstanceId ? { sessionInstanceId: old.sessionInstanceId } : {}),
    });
    await Promise.resolve();

    const fresh = await writeStorySession(
      conversationId,
      {
        phase: "review",
        storyZh: "新故事",
        messages: [{ id: "new", role: "user", source: "typed", text: "New." }],
        review: { score: 97, comment: "新代", rubric: null, suggestions: [] },
      },
      null,
    );
    expect(fresh.sessionInstanceId).not.toBe(old.sessionInstanceId);
    gate.release();
    await staleWrite;

    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: fresh.revision,
      sessionInstanceId: fresh.sessionInstanceId,
      review: { score: 97, comment: "新代", rubric: null },
    });
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
