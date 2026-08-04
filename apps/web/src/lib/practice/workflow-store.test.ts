import { describe, expect, test } from "vitest";
import { selectRecoveryWorkflows } from "./workflow-store";

describe("durable workflow selection", () => {
  test("uses stable newest update then client id ordering", () => {
    const base = {
      learnerId: "learner",
      clientSessionId: "session",
      promptId: "prompt",
      lang: "en" as const,
      attemptIndex: 1 as const,
      state: "awaiting-feedback" as const,
      updatedAt: 10,
      sessionId: "server-session",
      attemptId: "attempt",
    };
    expect(
      selectRecoveryWorkflows([
        { ...base, clientAttemptId: "b" },
        { ...base, clientAttemptId: "a", updatedAt: 11 },
      ])[0]?.clientAttemptId,
    ).toBe("a");
  });
});
