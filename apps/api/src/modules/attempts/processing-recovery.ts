export const ATTEMPT_PROCESSING_STALE_MS = 10 * 60 * 1000;

export function isAttemptProcessingStale(createdAt: Date, now = Date.now()) {
  return now - createdAt.getTime() >= ATTEMPT_PROCESSING_STALE_MS;
}
