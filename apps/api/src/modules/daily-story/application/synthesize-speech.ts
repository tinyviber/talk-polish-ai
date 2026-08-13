import { DailyStoryProviderNotConfiguredError } from "./ports";
import type { DailyStoryTtsConfig } from "@kotoba/contracts";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export function createSynthesizeSpeech(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  return (input: {
    learnerId: string;
    ip?: string;
    requestId: string;
    text: string;
    tts: DailyStoryTtsConfig;
  }) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "tts",
      perMinute: deps.config.dailyStoryRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: async () => {
        return deps.safeProviderCall(() => {
          const tts = deps.providers({ tts: input.tts }).tts;
          if (!tts) throw new DailyStoryProviderNotConfiguredError();
          return tts.synthesize({
            text: input.text,
            voice: input.tts.voice,
            locale: "en",
            requestId: input.requestId,
          });
        }, input.requestId);
      },
    });
}
