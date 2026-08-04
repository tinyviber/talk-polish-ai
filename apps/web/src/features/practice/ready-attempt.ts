import { toReadyAttempt } from "../../lib/practice/api";
import type { RecordingQueueItem } from "../../lib/practice/offlineQueue";

export function findReadyRecording(
  items: RecordingQueueItem[],
  clientAttemptId: string | null | undefined,
) {
  if (!clientAttemptId) return null;
  return (
    items.find(
      (item) =>
        item.clientAttemptId === clientAttemptId &&
        item.syncStatus === "ready" &&
        typeof item.attemptId === "string" &&
        item.attemptId.length > 0,
    ) ?? null
  );
}

export async function loadReadyAttempt(
  item: RecordingQueueItem,
  readAttempt: (
    attemptId: string,
  ) => Parameters<typeof toReadyAttempt>[0] | Promise<Parameters<typeof toReadyAttempt>[0]>,
) {
  if (item.syncStatus !== "ready" || !item.attemptId) return null;
  try {
    return {
      status: "ready" as const,
      attempt: toReadyAttempt(await readAttempt(item.attemptId)),
    };
  } catch (error) {
    return { status: "retry" as const, error };
  }
}
