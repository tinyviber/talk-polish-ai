import {
  syncRecordingQueue,
  type QueueUploadResult,
  type RecordingQueueItem,
  type SyncResult,
} from "../offlineQueue";

export function runRecordingOutboxSync(
  upload: (item: RecordingQueueItem) => Promise<QueueUploadResult>,
  learnerIds?: string | string[],
): Promise<SyncResult> {
  return syncRecordingQueue(upload, learnerIds);
}
