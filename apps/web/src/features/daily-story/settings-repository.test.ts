import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installFakeIndexedDb } from "@/lib/practice/test/fakeIndexedDb";
import {
  SessionConflictError,
  clearProvider,
  acquireStoryLease,
  claimStoryLease,
  listStorySessions,
  readProviderSettings,
  readStorySession,
  releaseStoryLease,
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

  test("normalizes legacy endpoint and infers provider preset on save", async () => {
    const saved = await saveProvider("asr", {
      baseUrl: "https://api.deepseek.com/",
      apiKey: "deepseek-key",
      model: "deepseek-v4-flash",
      preset: "openai-compatible",
    });
    expect(saved.asr?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.asr?.preset).toBe("deepseek");
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
});
