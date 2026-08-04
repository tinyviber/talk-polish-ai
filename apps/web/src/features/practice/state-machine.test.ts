import { describe, expect, test } from "vitest";
import { initialPracticeState, reducePracticeState } from "./state-machine";

describe("practice state machine", () => {
  test("requires first ready attempt before second feedback state", () => {
    const recording = reducePracticeState(initialPracticeState, { type: "begin" });
    const speaking = reducePracticeState(recording, { type: "recording" });
    const recorded = reducePracticeState(speaking, { type: "recorded" });
    const first = reducePracticeState(recorded, { type: "submit", attemptIndex: 1 });
    const processing = reducePracticeState(first, { type: "processing", attemptIndex: 1 });
    const feedback = reducePracticeState(processing, { type: "ready", attemptIndex: 1 });
    const secondReady = reducePracticeState(feedback, { type: "second-attempt-started" });
    const secondRecorded = reducePracticeState(secondReady, { type: "recording" });
    const second = reducePracticeState(secondRecorded, { type: "recorded" });
    const secondSubmitted = reducePracticeState(second, { type: "submit", attemptIndex: 2 });

    expect(first.stage).toBe("uploading");
    expect(processing.stage).toBe("processing");
    expect(feedback.stage).toBe("feedback");
    expect(secondSubmitted.stage).toBe("processing2");
  });

  test("offline recovery preserves attempt index and next prompt resets state", () => {
    const state = reducePracticeState(
      { stage: "recorded", attemptIndex: 2, error: null },
      { type: "offline", attemptIndex: 2 },
    );
    expect(state).toEqual({ stage: "offline-recovery", attemptIndex: 2, error: null });
    expect(reducePracticeState(state, { type: "next-prompt" })).toEqual(initialPracticeState);
  });

  test("illegal events cannot jump workflow stage", () => {
    expect(reducePracticeState(initialPracticeState, { type: "ready", attemptIndex: 1 })).toEqual(
      initialPracticeState,
    );
  });
});
