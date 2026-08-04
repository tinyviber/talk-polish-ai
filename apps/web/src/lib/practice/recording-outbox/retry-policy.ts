export const PROCESSING_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
export const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function backoffDelay(delays: readonly number[], index = 0) {
  return delays[Math.min(index, delays.length - 1)]!;
}
