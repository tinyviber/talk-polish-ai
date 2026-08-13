import type { Env } from "./env";
import { createAttemptApplication } from "./modules/attempts/service";
import { createDailyStoryModule } from "./modules/daily-story";
import type { DailyStoryService } from "./modules/daily-story";
import { providers, type Providers } from "./providers";

export type Runtime = {
  config: Env;
  providers: Providers;
  attemptApplication: ReturnType<typeof createAttemptApplication>;
  dailyStory: DailyStoryService;
};

/** API composition root: concrete capabilities are created once and injected. */
export function buildRuntime(config: Env): Runtime {
  const providerSet = providers(config);
  return {
    config,
    providers: providerSet,
    attemptApplication: createAttemptApplication(providerSet, config.MAX_UPLOAD_BYTES),
    dailyStory: createDailyStoryModule(config),
  };
}
