import { describe, expect, test } from "vitest";
import { belongsToFrozenSession, canAdoptRecovery } from "./recovery-policy";

describe("practice recovery adoption policy", () => {
  const sessionA = {
    clientSessionId: "session-a",
    sessionId: "server-a",
    promptId: "prompt-a",
    lang: "en" as const,
  };

  test("does not let another tab interrupt an active recording", () => {
    expect(canAdoptRecovery("recording", sessionA, "recording")).toBe(false);
    expect(canAdoptRecovery("recording", null, "recording")).toBe(false);
    expect(belongsToFrozenSession("session-b", sessionA)).toBe(false);
    expect(belongsToFrozenSession("session-a", sessionA)).toBe(true);
  });

  test("allows only cold-start adoption", () => {
    expect(canAdoptRecovery("prompt", null, "idle")).toBe(true);
    expect(canAdoptRecovery("prompt", null, "denied")).toBe(true);
    expect(canAdoptRecovery("prompt", sessionA, "idle")).toBe(false);
    expect(canAdoptRecovery("recorded", null, "idle")).toBe(false);
  });
});
