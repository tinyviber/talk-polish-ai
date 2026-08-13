import type {
  DailyStoryAsrConfig,
  DailyStoryChatConfig,
  DailyStoryHistoryMessage,
  DailyStoryTtsConfig,
} from "@kotoba/contracts";
import type { ProviderProbe } from "../../../platform/ai/probe";
import type { SpeechToText } from "../../../platform/ai/capabilities/speech-to-text";
import type { TextModel } from "../../../platform/ai/capabilities/text-model";
import type { TextToSpeech } from "../../../platform/ai/capabilities/text-to-speech";

export class DailyStoryProviderNotConfiguredError extends Error {
  readonly code = "provider_not_configured" as const;

  constructor() {
    super("Daily Story provider is not configured.");
    this.name = "DailyStoryProviderNotConfiguredError";
  }
}

export type ProbedTextModel = TextModel & ProviderProbe;
export type ProbedSpeechToText = SpeechToText & ProviderProbe;
export type ProbedTextToSpeech = TextToSpeech & ProviderProbe;

export type DailyStoryProviders = {
  chat?: ProbedTextModel;
  asr?: ProbedSpeechToText;
  tts?: ProbedTextToSpeech;
};

export type DailyStoryProviderFactory = (
  input: Partial<{
    chat: DailyStoryChatConfig;
    asr: DailyStoryAsrConfig;
    tts: DailyStoryTtsConfig;
  }>,
) => DailyStoryProviders;

export type DailyStoryRuntimeConfig = {
  dailyStoryRateLimitPerMinute: number;
  dailyStoryProviderCheckRateLimitPerMinute: number;
  dailyStoryConcurrentRequests: number;
};

export type DailyStoryGuard = <T>(input: {
  learnerId: string;
  ip?: string;
  capability: string;
  perMinute: number;
  concurrent: number;
  run: () => Promise<T>;
}) => Promise<T>;

export type SafeProviderCall = <T>(run: () => Promise<T>, requestId?: string) => Promise<T>;

export type DailyStoryReplyTurn = {
  id: string;
  source: "asr" | "typed";
  text: string;
};

export type DailyStoryConversationInput = {
  learnerId: string;
  ip?: string;
  requestId: string;
  storyZh: string;
  history: DailyStoryHistoryMessage[];
  chat: DailyStoryChatConfig;
};
