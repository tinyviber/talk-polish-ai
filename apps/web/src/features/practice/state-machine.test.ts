import { describe, expect, test } from "vitest";
import { initialPracticeState, reducePracticeState, transitionTo } from "./state-machine";

describe("practice state machine", () => {
  test("requires first ready attempt before second feedback state", () => {
    const first = reducePracticeState(initialPracticeState, { type: "submit", attemptIndex: 1 });
    const processing = reducePracticeState(first, { type: "processing", attemptIndex: 1 });
    const feedback = reducePracticeState(processing, { type: "ready", attemptIndex: 1 });
    const second = reducePracticeState(feedback, { type: "submit", attemptIndex: 2 });

    expect(first.stage).toBe("uploading");
    expect(processing.stage).toBe("processing");
    expect(feedback.stage).toBe("feedback");
    expect(second.stage).toBe("processing2");
  });

  test("offline recovery preserves attempt index and next prompt resets state", () => {
    const state = reducePracticeState(initialPracticeState, { type: "offline", attemptIndex: 2 });
    expect(state).toEqual({ stage: "offline-recovery", attemptIndex: 2, error: null });
    expect(reducePracticeState(state, { type: "next-prompt" })).toEqual(initialPracticeState);
  });

  test("legacy route stages still pass through explicit transition function", () => {
    expect(transitionTo(initialPracticeState, "processing2")).toMatchObject({
      stage: "processing2",
      attemptIndex: 2,
    });
  });
});
