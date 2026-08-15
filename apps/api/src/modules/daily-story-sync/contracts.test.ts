import { describe, expect, test } from "bun:test";
import {
  dailyStorySyncConversationSchema,
  dailyStorySyncListQuerySchema,
  dailyStorySyncListResponseSchema,
} from "@kotoba/contracts";

const validConversation = {
  conversationId: "conversation_test",
  schemaVersion: 1,
  revision: 2,
  sessionInstanceId: "session_test",
  updatedAt: "2026-08-15T00:00:00.000Z",
  phase: "chatting" as const,
  storyZh: "故事",
  messages: [{ id: "assistant_1", role: "assistant" as const, text: "How are you?" }],
};

describe("Daily Story sync contract", () => {
  test("accepts stable conversation aggregate", () => {
    expect(dailyStorySyncConversationSchema.safeParse(validConversation).success).toBe(true);
  });

  test("rejects credentials, audio, leases, and duplicate message ids", () => {
    expect(
      dailyStorySyncConversationSchema.safeParse({
        ...validConversation,
        apiKey: "must-not-sync",
        audio: { bytes: "bad" },
        lease: { ownerId: "bad" },
      }).success,
    ).toBe(false);
    expect(
      dailyStorySyncConversationSchema.safeParse({
        ...validConversation,
        messages: [
          ...validConversation.messages,
          { id: "assistant_1", role: "assistant" as const, text: "Duplicate" },
        ],
      }).success,
    ).toBe(false);
  });

  test("uses a bounded cursor page instead of a vault-wide object cap", () => {
    expect(dailyStorySyncListQuerySchema.parse({})).toEqual({});
    expect(
      dailyStorySyncListResponseSchema.safeParse({
        objects: [],
        nextCursor: null,
        requestId: "request",
      }).success,
    ).toBe(true);
  });
});
