import type { DailyStoryAudioOutboxItem } from "./audio-outbox";
import type { DailyStoryCachedAudio } from "./shared-types";

export type { DailyStoryCachedAudio } from "./shared-types";

export function toCachedAudio(item: DailyStoryAudioOutboxItem): DailyStoryCachedAudio {
  return {
    clientAttemptId: item.clientAttemptId,
    blob: item.blob,
    mimeType: item.mimeType,
    durationSec: item.durationSec,
    createdAt: item.createdAt,
    status: item.status,
    purpose: item.purpose,
    ...(item.readAloudTarget ? { readAloudTarget: item.readAloudTarget } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

export function splitDailyStoryAudio(items: DailyStoryAudioOutboxItem[]) {
  const latest = items.at(-1);
  return {
    // Keep cachedAudio as the latest item of either purpose for failed/read-aloud retries.
    cachedAudio: latest ? toCachedAudio(latest) : null,
    conversationAudios: items.filter((item) => item.purpose === "conversation").map(toCachedAudio),
  };
}

export function isDailyStoryCachedAudioRetryCurrent(
  mounted: boolean,
  retryGeneration: number,
  currentGeneration: number,
  pageActive = true,
) {
  return isDailyStoryPageActive(mounted, pageActive) && retryGeneration === currentGeneration;
}

export function isDailyStoryPageActive(mounted: boolean, pageActive: boolean) {
  return mounted && pageActive;
}
