import { describe, expect, test } from "vitest";
import {
  hydratePracticeWorkflow,
  queueIdentityForAttempt,
  selectFrozenPrompt,
} from "./workflow-context";

describe("frozen workflow context", () => {
  test("keeps cold-start attempt one identity for attempt two", () => {
    const context = hydratePracticeWorkflow({
      clientSessionId: "client-session-1",
      sessionId: "server-session-1",
      promptId: "ja-prompt-1",
      lang: "ja",
    });

    expect(queueIdentityForAttempt(context, 1)).toEqual({
      clientSessionId: "client-session-1",
      promptId: "ja-prompt-1",
      lang: "ja",
      attemptIndex: 1,
    });
    expect(queueIdentityForAttempt(context, 2)).toEqual({
      clientSessionId: "client-session-1",
      promptId: "ja-prompt-1",
      lang: "ja",
      attemptIndex: 2,
    });
  });

  test("selects the recovered prompt instead of the current offset prompt", () => {
    const prompts = [
      { id: "en-prompt", lang: "en", question: "English" },
      { id: "ja-prompt-1", lang: "ja", question: "日本語" },
    ] as never[];
    const recovered = hydratePracticeWorkflow({
      clientSessionId: "client-session-1",
      sessionId: "server-session-1",
      promptId: "ja-prompt-1",
      lang: "ja",
    });

    expect(selectFrozenPrompt(prompts, recovered, prompts[0]!)).toBe(prompts[1]);
  });
});
