import type { DailyStoryProviderCheckRequest } from "@kotoba/contracts";
import { DailyStoryProviderNotConfiguredError } from "./ports";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export type CheckProviderInput = {
  learnerId: string;
  ip?: string;
  requestId: string;
  request: DailyStoryProviderCheckRequest;
};

export function createCheckProvider(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  return (input: CheckProviderInput) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: `check:${input.request.capability}`,
      perMinute: deps.config.dailyStoryProviderCheckRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: () =>
        deps.safeProviderCall(async () => {
          const providers = deps.providers({ [input.request.capability]: input.request.provider });
          const provider =
            input.request.capability === "chat"
              ? providers.chat
              : input.request.capability === "asr"
                ? providers.asr
                : providers.tts;
          if (!provider || typeof provider.probe !== "function") {
            throw new DailyStoryProviderNotConfiguredError();
          }
          await provider.probe(input.requestId);
          return { capability: input.request.capability, status: "connected" as const };
        }, input.requestId),
    });
}
