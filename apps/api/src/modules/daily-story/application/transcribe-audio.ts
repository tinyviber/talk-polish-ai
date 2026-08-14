import { DailyStoryProviderNotConfiguredError } from "./ports";
import { createFaithfulTranscriptNormalizer } from "./normalize-transcript";
import type {
  DailyStoryAsrConfig,
  DailyStoryChatConfig,
  DailyStoryNormalizationHistory,
} from "@kotoba/contracts";
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
  const normalize = createFaithfulTranscriptNormalizer(deps);
  return (input: {
    learnerId: string;
    ip?: string;
    requestId: string;
    asr: DailyStoryAsrConfig;
    audio: Uint8Array;
    mimeType: string;
    chat?: DailyStoryChatConfig;
    storyZh?: string;
    recentHistory?: DailyStoryNormalizationHistory;
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
        return normalize({
          rawTranscript: transcript.text,
          requestId: input.requestId,
          ...(input.chat ? { chat: input.chat } : {}),
          ...(input.storyZh ? { storyZh: input.storyZh } : {}),
          ...(input.recentHistory ? { recentHistory: input.recentHistory } : {}),
        });
      },
    });
}
