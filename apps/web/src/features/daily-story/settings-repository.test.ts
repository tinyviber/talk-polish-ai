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
    });
    expect(saved.asr?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(saved.asr?.preset).toBe("deepseek");
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
