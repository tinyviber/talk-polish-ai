import { isFeedbackOutstanding } from "./transition-policy";
import type { RecordingQueueItem } from "./model";

export function shouldRetainForFeedback(item: RecordingQueueItem) {
  return isFeedbackOutstanding(item);
}
