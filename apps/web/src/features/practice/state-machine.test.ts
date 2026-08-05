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

  test("recovers attempt one from real processing through retry and ready", () => {
    const processing = reducePracticeState(
      { stage: "processing", attemptIndex: 1, error: null },
      { type: "offline", attemptIndex: 1 },
    );
    const retry = reducePracticeState(processing, { type: "retry", attemptIndex: 1 });
    const feedback = reducePracticeState(retry, { type: "ready", attemptIndex: 1 });

    expect(processing.stage).toBe("offline-recovery");
    expect(retry.stage).toBe("retry");
    expect(feedback.stage).toBe("feedback");
  });

  test("recovers attempt two from processing2 through retry and result", () => {
    const processing = reducePracticeState(
      { stage: "processing2", attemptIndex: 2, error: null },
      { type: "offline", attemptIndex: 2 },
    );
    const retry = reducePracticeState(processing, { type: "retry", attemptIndex: 2 });
    const result = reducePracticeState(retry, { type: "ready", attemptIndex: 2 });

    expect(processing.stage).toBe("offline-recovery");
    expect(retry.stage).toBe("retry");
    expect(result.stage).toBe("result");
  });

  test("rejects late ready and feedback events from another attempt", () => {
    const attemptTwoRecovery = {
      stage: "offline-recovery" as const,
      attemptIndex: 2 as const,
      error: null,
    };
    expect(reducePracticeState(attemptTwoRecovery, { type: "ready", attemptIndex: 1 })).toEqual(
      attemptTwoRecovery,
    );
    expect(
      reducePracticeState(attemptTwoRecovery, {
        type: "feedback-load-failed",
        message: "late attempt one response",
        attemptIndex: 1,
      }),
    ).toEqual(attemptTwoRecovery);
  });

  test("keeps durable pending and permanent failure out of recording UI", () => {
    const pending = reducePracticeState(initialPracticeState, {
      type: "durable-pending-adopted",
      workflowId: "attempt-1",
      attemptIndex: 1,
    });
    const failed = reducePracticeState(pending, {
      type: "permanent-failure",
      message: "unprocessable audio",
      attemptIndex: 1,
    });

    expect(pending.stage).toBe("offline-recovery");
    expect(failed.stage).toBe("permanent-failure");
    expect(reducePracticeState(failed, { type: "retry-existing", attemptIndex: 1 }).stage).toBe(
      "offline-recovery",
    );
  });

  test("adopts cold-start permanent failure with the durable attempt index", () => {
    const failedAttemptOne = reducePracticeState(initialPracticeState, {
      type: "permanent-failure-adopted",
      workflowId: "attempt-1",
      attemptIndex: 1,
      message: "attempt one failed",
    });
    const failedAttemptTwo = reducePracticeState(initialPracticeState, {
      type: "permanent-failure-adopted",
      workflowId: "attempt-2",
      attemptIndex: 2,
      message: "attempt two failed",
    });

    expect(failedAttemptOne).toEqual({
      stage: "permanent-failure",
      attemptIndex: 1,
      error: "attempt one failed",
    });
    expect(failedAttemptTwo).toEqual({
      stage: "permanent-failure",
      attemptIndex: 2,
      error: "attempt two failed",
    });
  });

  test("rejects a late attempt one permanent failure while attempt two is active", () => {
    const attemptTwo = { stage: "processing2" as const, attemptIndex: 2 as const, error: null };

    expect(
      reducePracticeState(attemptTwo, {
        type: "permanent-failure",
        attemptIndex: 1,
        message: "late attempt one failure",
      }),
    ).toEqual(attemptTwo);
  });

  test("illegal events cannot jump workflow stage", () => {
    expect(reducePracticeState(initialPracticeState, { type: "ready", attemptIndex: 1 })).toEqual(
      initialPracticeState,
    );
    const recording = {
      stage: "recording" as const,
      attemptIndex: 1 as const,
      error: null,
    };
    expect(
      reducePracticeState(recording, {
        type: "feedback-load-failed",
        message: "late tab event",
        attemptIndex: 1,
      }),
    ).toEqual(recording);
    expect(
      reducePracticeState(initialPracticeState, {
        type: "recovery-workflow-adopted",
        workflowId: "workflow-b",
        attemptIndex: 1,
      }).stage,
    ).toBe("feedback-recovery");
    expect(
      reducePracticeState(recording, {
        type: "recovery-workflow-adopted",
        workflowId: "workflow-b",
        attemptIndex: 1,
      }),
    ).toEqual(recording);
  });

  test("keeps feedback recovery when durable consume fails", () => {
    const feedback = reducePracticeState(
      { stage: "feedback", attemptIndex: 1, error: null },
      { type: "ready", attemptIndex: 1 },
    );
    expect(
      reducePracticeState(feedback, {
        type: "feedback-delivery-failed",
        message: "transaction aborted",
        attemptIndex: 1,
        clientAttemptId: "attempt-1",
      }),
    ).toEqual({ stage: "feedback-recovery", attemptIndex: 1, error: "transaction aborted" });
  });
});
