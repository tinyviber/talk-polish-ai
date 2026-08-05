import { isFeedbackOutstanding } from "./transition-policy";
import type { RecordingQueueItem } from "./model";

export const LEGACY_UNKNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function shouldRetainForFeedback(item: RecordingQueueItem, now = Date.now()) {
  if (!isFeedbackOutstanding(item)) return false;
  if (item.workflowState !== "legacy-unknown") return true;
  return now - item.createdAt <= LEGACY_UNKNOWN_RETENTION_MS;
}
