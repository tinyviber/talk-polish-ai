import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installFakeIndexedDb } from "@/lib/practice/test/fakeIndexedDb";
import {
  SessionConflictError,
  clearProvider,
  readProviderSettings,
  readStorySession,
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
});
