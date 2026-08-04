import type { Lang } from "../types";

export type QueueStatus =
  "local-draft" | "queued" | "uploading" | "processing" | "ready" | "failed";
export type DurableWorkflowState =
  "awaiting-upload" | "awaiting-feedback" | "consumed" | "abandoned";
export type FeedbackState = "pending" | "delivered" | "error";

export type RecordingQueueItem = {
  learnerId: string;
  clientAttemptId: string;
  sessionId: string | null;
  clientSessionId: string;
  promptId: string;
  lang: Lang;
  attemptIndex: 1 | 2;
  duration: number;
  mimeType: string;
  blob: Blob;
  createdAt: number;
  syncStatus: QueueStatus;
  attemptId?: string | undefined;
  lastError?: string | undefined;
  blobDiscarded?: boolean | undefined;
  nextPollAt?: number | undefined;
  processingPollIndex?: number | undefined;
  transientRetryIndex?: number | undefined;
  prerequisiteSatisfied?: boolean | undefined;
  feedbackState?: FeedbackState | undefined;
  feedbackLastError?: string | undefined;
  feedbackUpdatedAt?: number | undefined;
  workflowState?: DurableWorkflowState | undefined;
  workflowUpdatedAt?: number | undefined;
  revision?: number | undefined;
};
