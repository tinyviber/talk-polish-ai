import { describe, expect, test } from "vitest";
import type { DailyStorySyncConversation } from "@kotoba/contracts";
import { safeMerge, truncateConflictTitle } from "./worker";

const base: DailyStorySyncConversation = {
  conversationId: "conversation_sync_logic",
  schemaVersion: 1,
  revision: 2,
  sessionInstanceId: "session_sync_logic",
  updatedAt: "2026-08-15T00:00:00.000Z",
  phase: "chatting",
  storyZh: "故事",
  messages: [{ id: "a1", role: "assistant", text: "Hello." }],
};

describe("Daily Story sync merge safeguards", () => {
  test("accepts one-sided append and rejects divergent edits", () => {
    const local = {
      ...base,
      revision: 3,
      updatedAt: "2026-08-15T00:00:01.000Z",
      messages: [...base.messages, { id: "u1", role: "user" as const, text: "Hi." }],
    };
    const remote = {
      ...base,
      revision: 3,
      updatedAt: "2026-08-15T00:00:02.000Z",
      messages: [...base.messages, { id: "u2", role: "user" as const, text: "Hey." }],
    };
    expect(safeMerge(base, local)?.messages).toHaveLength(2);
    expect(safeMerge(local, remote)).toBeNull();
  });

  test("requires the same session generation and bounds conflict titles", () => {
    expect(safeMerge(base, { ...base, sessionInstanceId: "other_session" })).toBeNull();
    expect(truncateConflictTitle("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
