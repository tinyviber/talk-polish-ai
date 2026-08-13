import { DailyStoryProviderNotConfiguredError } from "./ports";
import type { DailyStoryAsrConfig } from "@kotoba/contracts";
import type {
  DailyStoryGuard,
  DailyStoryProviderFactory,
  DailyStoryRuntimeConfig,
  SafeProviderCall,
} from "./ports";

export function createTranscribeAudio(deps: {
  config: DailyStoryRuntimeConfig;
  providers: DailyStoryProviderFactory;
  guard: DailyStoryGuard;
  safeProviderCall: SafeProviderCall;
}) {
  return (input: {
    learnerId: string;
    ip?: string;
    requestId: string;
    asr: DailyStoryAsrConfig;
    audio: Uint8Array;
    mimeType: string;
  }) =>
    deps.guard({
      learnerId: input.learnerId,
      ip: input.ip,
      capability: "asr",
      perMinute: deps.config.dailyStoryRateLimitPerMinute,
      concurrent: deps.config.dailyStoryConcurrentRequests,
      run: async () => {
        const transcript = await deps.safeProviderCall(() => {
          const asr = deps.providers({ asr: input.asr }).asr;
          if (!asr) throw new DailyStoryProviderNotConfiguredError();
          return asr.transcribe({
            audio: input.audio,
            mimeType: input.mimeType,
            locale: "en",
            granularity: "text",
            requestId: input.requestId,
          });
        }, input.requestId);
        return { transcript: transcript.text };
      },
    });
}
