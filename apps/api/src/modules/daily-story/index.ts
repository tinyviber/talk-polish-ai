import type { Env } from "../../env";
import { createDailyStoryRequestProviders } from "../../providers/request-scoped";
import { withDailyStoryRequestGuard } from "./request-guards";
import { createSafeProviderCall } from "./infrastructure/provider-call";
import { createDailyStoryService, type DailyStoryService } from "./service";

/** Composition root for the Daily Story module. Keep Env and adapters here. */
export function createDailyStoryModule(config: Env): DailyStoryService {
  return createDailyStoryService({
    config: {
      dailyStoryRateLimitPerMinute: config.DAILY_STORY_RATE_LIMIT_PER_MINUTE,
      dailyStoryProviderCheckRateLimitPerMinute:
        config.DAILY_STORY_PROVIDER_CHECK_RATE_LIMIT_PER_MINUTE,
      dailyStoryConcurrentRequests: config.DAILY_STORY_CONCURRENT_REQUESTS,
    },
    providers: (input) => createDailyStoryRequestProviders(config, input),
    guard: withDailyStoryRequestGuard,
    safeProviderCall: createSafeProviderCall(config.NODE_ENV),
  });
}

export { type DailyStoryService } from "./service";
