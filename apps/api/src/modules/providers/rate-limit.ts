import { env } from "../../env";
import { ApiError } from "../../http/errors";

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const buckets = new Map<string, { startedAt: number; count: number }>();

/**
 * Small per-process guardrail for anonymous provider spend. Production should
 * also enforce IP/device quotas at the gateway because this map is not shared
 * between API replicas.
 */
export function enforceProviderRateLimit(learnerId: string, capability: string, ip?: string) {
  const now = Date.now();
  prune(now);
  for (const key of [`learner:${learnerId}:${capability}`, ip ? `ip:${ip}:${capability}` : null]) {
    if (!key) continue;
    const current = buckets.get(key);
    if (current && current.count >= env().PROVIDER_RATE_LIMIT_PER_MINUTE) {
      throw ApiError.rateLimited();
    }
  }
  for (const key of [`learner:${learnerId}:${capability}`, ip ? `ip:${ip}:${capability}` : null]) {
    if (!key) continue;
    const current = buckets.get(key);
    if (current) current.count += 1;
    else buckets.set(key, { startedAt: now, count: 1 });
  }
}

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(key);
  }
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (!oldest) break;
    buckets.delete(oldest);
  }
}

export function resetProviderRateLimitsForTests() {
  buckets.clear();
}
