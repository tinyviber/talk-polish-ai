import {
  reducePracticeState,
  type PracticeEvent,
  type PracticeStage,
  type PracticeState,
} from "./state-machine";
import type { FrozenPracticeContext } from "@/lib/practice/workflow-context";
import type { RecordingQueueItem } from "@/lib/practice/recording-outbox/model";

export type WorkflowTerminalDisposition = "consumed" | "abandoned" | "delivered";

export type WorkflowHandledElsewhereResolution = {
  clientAttemptId: string;
  disposition: WorkflowTerminalDisposition;
  matchesCurrentWorkflow: boolean;
  shouldReset: boolean;
  resetSessionContext: boolean;
  event: Extract<PracticeEvent, { type: "workflow-resolved-elsewhere" }> | null;
};

export type ReconciliationQueueItem = Pick<
  RecordingQueueItem,
  "clientAttemptId" | "workflowState" | "feedbackState"
>;

const HANDOFF_STAGES: ReadonlySet<PracticeStage> = new Set([
  "feedback-recovery",
  "offline-recovery",
  "retry",
  "permanent-failure",
]);

function terminalDisposition(item: ReconciliationQueueItem): WorkflowTerminalDisposition | null {
  if (item.workflowState === "consumed") return "consumed";
  if (item.workflowState === "abandoned") return "abandoned";
  if (item.feedbackState === "delivered") return "delivered";
  return null;
}

/**
 * Application action for a workflow completed by another tab.
 * Matching is intentionally limited to the active attempt or recovery target.
 */
export function resolveWorkflowHandledElsewhere({
  clientAttemptId,
  disposition,
  activeClientAttemptId,
  currentTarget,
  currentStage,
}: {
  clientAttemptId: string;
  disposition: WorkflowTerminalDisposition;
  activeClientAttemptId: string | null;
  currentTarget: { clientAttemptId: string } | null;
  currentStage: PracticeStage;
}): WorkflowHandledElsewhereResolution {
  const matchesCurrentWorkflow =
    activeClientAttemptId === clientAttemptId || currentTarget?.clientAttemptId === clientAttemptId;
  const shouldReset = matchesCurrentWorkflow && HANDOFF_STAGES.has(currentStage);

  return {
    clientAttemptId,
    disposition,
    matchesCurrentWorkflow,
    shouldReset,
    resetSessionContext: shouldReset,
    event: shouldReset ? { type: "workflow-resolved-elsewhere", clientAttemptId } : null,
  };
}

/**
 * Reconciles one queue snapshot into the terminal handoff action used by the
 * Practice route. It never adopts or resets a row belonging to another session.
 */
export function reconcileWorkflowSnapshot({
  items,
  activeClientAttemptId,
  currentTarget,
  currentStage,
}: {
  items: readonly ReconciliationQueueItem[];
  activeClientAttemptId: string | null;
  currentTarget: { clientAttemptId: string } | null;
  currentStage: PracticeStage;
}) {
  const candidateIds = [activeClientAttemptId, currentTarget?.clientAttemptId ?? null].filter(
    (id, index, candidates): id is string => !!id && candidates.indexOf(id) === index,
  );

  for (const candidateId of candidateIds) {
    const item = items.find((queueItem) => queueItem.clientAttemptId === candidateId);
    const disposition = item ? terminalDisposition(item) : null;
    if (!disposition) continue;
    const resolution = resolveWorkflowHandledElsewhere({
      clientAttemptId: candidateId,
      disposition,
      activeClientAttemptId,
      currentTarget,
      currentStage,
    });
    if (resolution.shouldReset) return resolution;
  }

  return null;
}

/** Projection used by route/workflow tests to exercise the complete handoff. */
export type PracticeWorkflowProjection = {
  state: PracticeState;
  workflowGeneration: number;
  queueReadGeneration: number;
  interruptedAttemptId: string | null;
  pendingFeedbackAttemptId: string | null;
  readyAttemptResolutionKeys: string[];
  feedbackDeliveryAttemptIds: string[];
  feedbackDeliveryWorkflowIds: string[];
  feedbackDeliveryOutcomeIds: string[];
  recoveryTargetClientAttemptId: string | null;
  feedbackPendingDelivery: string | null;
  feedbackRetryPending: boolean;
  interruptedDraftPending: boolean;
  first: unknown | null;
  second: unknown | null;
  frozenContext: FrozenPracticeContext | null;
  sessionId: string | null;
  clientSessionId: string | null;
  error: string | null;
};

/**
 * Testable projection of the route's atomic cleanup. The route applies the
 * same fields to React state and refs, while recorder.reset() remains a UI
 * side effect at the route boundary.
 */
export function applyWorkflowHandledElsewhereProjection(
  projection: PracticeWorkflowProjection,
  resolution: WorkflowHandledElsewhereResolution | null,
  nextClientSessionId: string,
) {
  if (!resolution?.shouldReset || !resolution.event) return projection;
  const prefix = `${resolution.clientAttemptId}:`;

  return {
    ...projection,
    state: reducePracticeState(projection.state, resolution.event),
    workflowGeneration: projection.workflowGeneration + 1,
    queueReadGeneration: projection.queueReadGeneration + 1,
    interruptedAttemptId: null,
    pendingFeedbackAttemptId: null,
    readyAttemptResolutionKeys: projection.readyAttemptResolutionKeys.filter(
      (key) => !key.startsWith(prefix),
    ),
    feedbackDeliveryAttemptIds: projection.feedbackDeliveryAttemptIds.filter(
      (id) => id !== resolution.clientAttemptId,
    ),
    feedbackDeliveryWorkflowIds: projection.feedbackDeliveryWorkflowIds.filter(
      (id) => id !== resolution.clientAttemptId,
    ),
    feedbackDeliveryOutcomeIds: projection.feedbackDeliveryOutcomeIds.filter(
      (id) => id !== resolution.clientAttemptId,
    ),
    recoveryTargetClientAttemptId: null,
    feedbackPendingDelivery: null,
    feedbackRetryPending: false,
    interruptedDraftPending: false,
    first: null,
    second: null,
    frozenContext: null,
    sessionId: null,
    clientSessionId: nextClientSessionId,
    error: null,
  };
}
