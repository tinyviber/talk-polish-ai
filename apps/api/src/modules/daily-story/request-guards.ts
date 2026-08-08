import { ApiError } from "../../http/errors";

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const MAX_ACTIVE = 1_000;
const buckets = new Map<string, { startedAt: number; count: number }>();
const active = new Map<string, number>();

export async function withDailyStoryRequestGuard<T>(input: {
  learnerId: string;
  ip?: string;
  capability: string;
  perMinute: number;
  concurrent: number;
  run: () => Promise<T>;
}): Promise<T> {
  const now = Date.now();
  pruneExpiredBuckets(now);
  const keys = [
    `learner:${input.learnerId}:${input.capability}`,
    ...(input.ip ? [`ip:${input.ip}:${input.capability}`] : []),
  ];
  const missingBuckets = keys.filter((key) => !buckets.has(key)).length;
  if (buckets.size + missingBuckets > MAX_BUCKETS) throw ApiError.rateLimited();
  for (const key of keys) {
    const current = buckets.get(key);
    if (current && now - current.startedAt < WINDOW_MS && current.count >= input.perMinute) {
      throw ApiError.rateLimited();
    }
  }
  for (const key of keys) {
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= WINDOW_MS)
      buckets.set(key, { startedAt: now, count: 1 });
    else current.count += 1;
  }

  const activeKey = `learner:${input.learnerId}:${input.capability}`;
  const currentActive = active.get(activeKey) ?? 0;
  if (currentActive === 0 && active.size >= MAX_ACTIVE) throw ApiError.rateLimited();
  if (currentActive >= input.concurrent) {
    throw ApiError.rateLimited(
      "Daily Story request is already in progress. Please try again shortly.",
    );
  }
  active.set(activeKey, currentActive + 1);
  try {
    return await input.run();
  } finally {
    const remaining = (active.get(activeKey) ?? 1) - 1;
    if (remaining <= 0) active.delete(activeKey);
    else active.set(activeKey, remaining);
  }
}

function pruneExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(key);
  }
}

export function resetDailyStoryRequestGuardsForTests() {
  buckets.clear();
  active.clear();
}
