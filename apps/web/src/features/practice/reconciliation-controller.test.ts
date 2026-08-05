import { describe, expect, test } from "vitest";
import {
  applyWorkflowHandledElsewhereProjection,
  reconcileWorkflowSnapshot,
  type PracticeWorkflowProjection,
} from "./reconciliation-controller";
import { initialPracticeState, reducePracticeState, type PracticeState } from "./state-machine";
import {
  hydratePracticeWorkflow,
  type FrozenPracticeContext,
} from "@/lib/practice/workflow-context";

const frozenContext: FrozenPracticeContext = {
  clientSessionId: "client-session-a",
  sessionId: "server-session-a",
  promptId: "prompt-a",
  lang: "en",
};

function projection(state: PracticeState): PracticeWorkflowProjection {
  return {
    state,
    workflowGeneration: 4,
    queueReadGeneration: 7,
    interruptedAttemptId: "attempt-a",
    pendingFeedbackAttemptId: "attempt-a",
    readyAttemptResolutionKeys: ["attempt-a:4", "attempt-b:4"],
    feedbackDeliveryAttemptIds: ["attempt-a", "attempt-b"],
    feedbackDeliveryWorkflowIds: ["attempt-a", "attempt-b"],
    feedbackDeliveryOutcomeIds: ["attempt-a", "attempt-b"],
    recoveryTargetClientAttemptId: "attempt-a",
    feedbackPendingDelivery: "attempt-a",
    feedbackRetryPending: true,
    interruptedDraftPending: true,
    first: { id: "first" },
    second: { id: "second" },
    frozenContext,
    sessionId: "server-session-a",
    clientSessionId: "client-session-a",
    error: "old error",
  };
}

function uiFor(state: PracticeState) {
  return {
    recordControls: ["record", "record2", "recording", "recorded"].includes(state.stage),
    submissionFailure: state.stage === "permanent-failure",
    feedbackRecovery: state.stage === "feedback-recovery",
    retryUpload: state.stage === "offline-recovery" || state.stage === "retry",
    retryExisting: state.stage === "permanent-failure",
  };
}

describe("Practice workflow reconciliation controller", () => {
  test.each([
    ["offline-recovery", "delivered"],
    ["feedback-recovery", "consumed"],
    ["permanent-failure", "abandoned"],
  ] as const)("resets %s after the same workflow is %s elsewhere", (stage, disposition) => {
    const activeState = {
      stage,
      attemptIndex: 2 as const,
      error: "recovery error",
    };
    const action = reconcileWorkflowSnapshot({
      items: [
        {
          clientAttemptId: "attempt-a",
          workflowState:
            disposition === "abandoned"
              ? "abandoned"
              : disposition === "delivered"
                ? "awaiting-feedback"
                : "consumed",
          feedbackState: disposition === "delivered" ? "delivered" : "pending",
        },
      ],
      activeClientAttemptId: "attempt-a",
      currentTarget: { clientAttemptId: "attempt-a" },
      currentStage: stage,
    });
    const next = applyWorkflowHandledElsewhereProjection(
      projection(activeState),
      action,
      "client-session-new",
    );

    expect(action).toMatchObject({
      clientAttemptId: "attempt-a",
      disposition,
      matchesCurrentWorkflow: true,
      shouldReset: true,
      resetSessionContext: true,
      event: { type: "workflow-resolved-elsewhere", clientAttemptId: "attempt-a" },
    });
    expect(next.state).toEqual(initialPracticeState);
    expect(next.recoveryTargetClientAttemptId).toBeNull();
    expect(next.frozenContext).toBeNull();
    expect(next.sessionId).toBeNull();
    expect(next.clientSessionId).toBe("client-session-new");
    expect(next.interruptedAttemptId).toBeNull();
    expect(next.pendingFeedbackAttemptId).toBeNull();
    expect(next.feedbackPendingDelivery).toBeNull();
    expect(next.feedbackRetryPending).toBe(false);
    expect(next.interruptedDraftPending).toBe(false);
    expect(next.first).toBeNull();
    expect(next.second).toBeNull();
    expect(next.readyAttemptResolutionKeys).toEqual(["attempt-b:4"]);
    expect(next.feedbackDeliveryAttemptIds).toEqual(["attempt-b"]);
    expect(next.feedbackDeliveryWorkflowIds).toEqual(["attempt-b"]);
    expect(next.feedbackDeliveryOutcomeIds).toEqual(["attempt-b"]);
    expect(next.workflowGeneration).toBe(5);
    expect(next.queueReadGeneration).toBe(8);
    expect(uiFor(next.state)).toEqual({
      recordControls: false,
      submissionFailure: false,
      feedbackRecovery: false,
      retryUpload: false,
      retryExisting: false,
    });
  });

  test("resolves a cold-start failed attempt two without exposing recording controls", () => {
    const workflow = {
      clientAttemptId: "attempt-two",
      clientSessionId: "client-session-two",
      sessionId: "server-session-two",
      promptId: "prompt-two",
      lang: "ja" as const,
      attemptIndex: 2 as const,
    };
    const adopted = reducePracticeState(initialPracticeState, {
      type: "permanent-failure-adopted",
      workflowId: workflow.clientAttemptId,
      attemptIndex: workflow.attemptIndex,
      message: "validation failed",
    });

    expect(adopted).toEqual({
      stage: "permanent-failure",
      attemptIndex: 2,
      error: "validation failed",
    });
    expect(hydratePracticeWorkflow(workflow)).toMatchObject({
      clientSessionId: workflow.clientSessionId,
      sessionId: workflow.sessionId,
      promptId: workflow.promptId,
      lang: workflow.lang,
    });
    expect(uiFor(adopted)).toEqual({
      recordControls: false,
      submissionFailure: true,
      feedbackRecovery: false,
      retryUpload: false,
      retryExisting: true,
    });
  });

  test("leaves the active recording untouched when another workflow is terminal", () => {
    const current = projection({ stage: "recording", attemptIndex: 1, error: null });
    const action = reconcileWorkflowSnapshot({
      items: [
        {
          clientAttemptId: "attempt-b",
          workflowState: "consumed",
          feedbackState: "delivered",
        },
      ],
      activeClientAttemptId: "attempt-a",
      currentTarget: { clientAttemptId: "attempt-a" },
      currentStage: "recording",
    });

    expect(action).toBeNull();
    expect(applyWorkflowHandledElsewhereProjection(current, action, "client-session-new")).toBe(
      current,
    );
    expect(current.state.stage).toBe("recording");
    expect(current.frozenContext).toEqual(frozenContext);
    expect(current.sessionId).toBe("server-session-a");
    expect(current.clientSessionId).toBe("client-session-a");
  });
});
