import { describe, expect, test } from "vitest";
import {
  clearRecoveryTarget,
  replaceRecoveryTarget,
  selectRecoveryWorkflows,
} from "./workflow-store";

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

  test("replaces an old recovery target when a newer attempt fails", () => {
    const first = {
      learnerId: "learner",
      clientSessionId: "session-1",
      clientAttemptId: "attempt-1",
      promptId: "prompt-1",
      lang: "en" as const,
      attemptIndex: 1 as const,
      state: "awaiting-feedback" as const,
      updatedAt: 1,
      sessionId: "server-session-1",
      attemptId: "server-attempt-1",
    };
    const second = { ...first, clientAttemptId: "attempt-2", attemptId: "server-attempt-2" };

    expect(replaceRecoveryTarget(first, second)).toBe(second);
    expect(clearRecoveryTarget(first, "attempt-1")).toBeNull();
    expect(clearRecoveryTarget(first, "attempt-2")).toBe(first);
  });
});
