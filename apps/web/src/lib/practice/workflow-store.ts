import {
  abandonPracticeWorkflow,
  adoptLegacyWorkflow,
  listLegacyUnknownWorkflows,
  listDurablePracticeWorkflows,
  listPendingPracticeWorkflows,
  type DurableWorkflowState,
  type QueueStatus,
  type RecordingQueueItem,
} from "./offlineQueue";

export type DurablePracticeWorkflow = Pick<
  RecordingQueueItem,
  "learnerId" | "clientSessionId" | "clientAttemptId" | "promptId" | "lang" | "attemptIndex"
> & {
  state: DurableWorkflowState;
  syncStatus?: QueueStatus;
  updatedAt: number;
  sessionId: string | null;
  attemptId: string | null;
  lastError?: string;
};

export function replaceRecoveryTarget(
  _current: DurablePracticeWorkflow | null,
  next: DurablePracticeWorkflow,
) {
  return next;
}

export function clearRecoveryTarget(
  current: DurablePracticeWorkflow | null,
  clientAttemptId: string | null,
) {
  return clientAttemptId && current?.clientAttemptId === clientAttemptId ? null : current;
}

/** IndexedDB-backed recovery source. Selection order is newest update, then id. */
export async function listRecoveryWorkflows(learnerIds: string[]) {
  const items = await listDurablePracticeWorkflows(learnerIds);
  return selectRecoveryWorkflows(items.map(toDurablePracticeWorkflow));
}

export async function listLegacyRecoveryWorkflows(learnerIds: string[]) {
  const items = await listLegacyUnknownWorkflows(learnerIds);
  return selectRecoveryWorkflows(items.map(toDurablePracticeWorkflow));
}

export async function listPendingRecoveryWorkflows(learnerIds: string[]) {
  const items = await listPendingPracticeWorkflows(learnerIds);
  return selectRecoveryWorkflows(items.map(toDurablePracticeWorkflow));
}

export function toDurablePracticeWorkflow(item: RecordingQueueItem): DurablePracticeWorkflow {
  return {
    learnerId: item.learnerId,
    clientSessionId: item.clientSessionId,
    clientAttemptId: item.clientAttemptId,
    promptId: item.promptId,
    lang: item.lang,
    attemptIndex: item.attemptIndex,
    state: item.workflowState ?? "awaiting-feedback",
    syncStatus: item.syncStatus,
    updatedAt: item.workflowUpdatedAt ?? item.createdAt,
    sessionId: item.sessionId,
    attemptId: item.attemptId ?? null,
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
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

export async function restoreLegacyWorkflow(clientAttemptId: string) {
  await adoptLegacyWorkflow(clientAttemptId);
}
