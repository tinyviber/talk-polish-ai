import type { QueueStatus, RecordingQueueItem } from "./model";

export function isFeedbackOutstanding(item: RecordingQueueItem) {
  return (
    item.syncStatus === "ready" &&
    typeof item.attemptId === "string" &&
    item.attemptId.length > 0 &&
    item.workflowState !== "abandoned" &&
    item.workflowState !== "consumed" &&
    (item.feedbackState ?? "pending") !== "delivered"
  );
}

export function isQueueSyncCandidate(status: QueueStatus) {
  return status === "queued" || status === "uploading" || status === "processing";
}

export function recoverQueueStatus(status: QueueStatus): QueueStatus {
  return status === "uploading" ? "queued" : status;
}

export function canMoveWorkflowToReady(item: RecordingQueueItem) {
  return item.workflowState !== "consumed" && item.workflowState !== "abandoned";
}
