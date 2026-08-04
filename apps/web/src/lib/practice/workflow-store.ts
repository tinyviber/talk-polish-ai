import {
  abandonPracticeWorkflow,
  listDurablePracticeWorkflows,
  type DurableWorkflowState,
  type RecordingQueueItem,
} from "./offlineQueue";

export type DurablePracticeWorkflow = Pick<
  RecordingQueueItem,
  "learnerId" | "clientSessionId" | "clientAttemptId" | "promptId" | "lang" | "attemptIndex"
> & {
  state: DurableWorkflowState;
  updatedAt: number;
  sessionId: string | null;
  attemptId: string;
};

/** IndexedDB-backed recovery source. Selection order is newest update, then id. */
export async function listRecoveryWorkflows(learnerIds: string[]) {
  const items = await listDurablePracticeWorkflows(learnerIds);
  return selectRecoveryWorkflows(
    items.map<DurablePracticeWorkflow>((item) => ({
      learnerId: item.learnerId,
      clientSessionId: item.clientSessionId,
      clientAttemptId: item.clientAttemptId,
      promptId: item.promptId,
      lang: item.lang,
      attemptIndex: item.attemptIndex,
      state: item.workflowState ?? "awaiting-feedback",
      updatedAt: item.workflowUpdatedAt ?? item.createdAt,
      sessionId: item.sessionId,
      attemptId: item.attemptId!,
    })),
  );
}

/** Stable newest-first selection; ties resolve by clientAttemptId. */
export function selectRecoveryWorkflows(workflows: DurablePracticeWorkflow[]) {
  return [...workflows].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.clientAttemptId.localeCompare(b.clientAttemptId),
  );
}

export async function abandonWorkflow(clientAttemptId: string) {
  await abandonPracticeWorkflow(clientAttemptId);
}
