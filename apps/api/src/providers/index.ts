import { env } from "../env";
import { createLocalAudioStorage } from "./local-storage";
import { createS3AudioStorage } from "./s3-storage";
import { createMockAssessmentProvider } from "./mock/assessment";
import { createMockTranscriptionProvider } from "./mock/transcription";
import { createMockTtsProvider } from "./mock/tts";
import { createOpenAICompatibleAssessmentProvider } from "./openai-assessment";
import { createOpenAICompatibleTranscriptionProvider } from "./openai-transcription";
import { createOpenAICompatibleTtsProvider } from "./openai-tts";
import { localLlmConfig } from "./llm-config";
import { createRealtimeProvider, type RealtimeProvider } from "./realtime";
import type { AssessmentProvider } from "./assessment";
import type { AudioStorageProvider } from "./storage";
import type { TranscriptionProvider } from "./transcription";
import type { TextToSpeechProvider } from "./tts";

export type Providers = {
  transcription: TranscriptionProvider;
  assessment: AssessmentProvider;
  tts: TextToSpeechProvider;
  storage: AudioStorageProvider;
  realtime: RealtimeProvider;
};

let cached: Providers | undefined;

/**
 * Single place where provider implementations are chosen from configuration.
 * Add new drivers here — nothing else in the codebase constructs a provider.
 */
export function providers(): Providers {
  if (cached) return cached;
  const config = env();

  const storage =
    config.AUDIO_STORAGE_DRIVER === "s3"
      ? createS3AudioStorage({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          requestTimeoutMs: config.S3_REQUEST_TIMEOUT_MS,
          maxAttempts: config.S3_MAX_ATTEMPTS,
          maxObjectBytes: config.S3_MAX_OBJECT_BYTES,
          keyPrefix: config.S3_KEY_PREFIX,
        })
      : createLocalAudioStorage(config.DATA_DIR);

  const chat = {
    baseUrl: config.CHAT_BASE_URL,
    apiKey: config.CHAT_API_KEY,
    model: config.CHAT_MODEL ?? localLlmConfig("chat").model,
    timeoutMs: config.CHAT_TIMEOUT_MS,
    maxAttempts: config.HTTP_MAX_ATTEMPTS,
  };
  const transcription = {
    baseUrl: config.TRANSCRIPTION_BASE_URL,
    apiKey: config.TRANSCRIPTION_API_KEY,
    model: config.TRANSCRIPTION_MODEL ?? localLlmConfig("transcription").model,
    timeoutMs: config.TRANSCRIPTION_TIMEOUT_MS,
    maxAttempts: config.HTTP_MAX_ATTEMPTS,
  };
  const tts = {
    baseUrl: config.TTS_BASE_URL,
    apiKey: config.TTS_API_KEY,
    model: config.TTS_MODEL ?? localLlmConfig("tts").model,
    voice: config.TTS_VOICE,
    timeoutMs: config.TTS_TIMEOUT_MS,
    maxAttempts: config.HTTP_MAX_ATTEMPTS,
  };

  cached = {
    transcription:
      config.TRANSCRIPTION_PROVIDER === "openai-compatible"
        ? createOpenAICompatibleTranscriptionProvider(transcription, storage)
        : createMockTranscriptionProvider(),
    assessment:
      config.ASSESSMENT_PROVIDER === "openai-compatible"
        ? createOpenAICompatibleAssessmentProvider(chat)
        : createMockAssessmentProvider(),
    tts:
      config.TTS_PROVIDER === "openai-compatible"
        ? createOpenAICompatibleTtsProvider(tts, storage)
        : createMockTtsProvider(),
    storage,
    realtime: createRealtimeProvider({
      enabled: config.REALTIME_FEATURE_ENABLED,
      url: config.REALTIME_URL,
      apiKey: config.REALTIME_API_KEY,
      model: config.REALTIME_MODEL,
      protocol: config.REALTIME_PROTOCOL,
      timeoutMs: config.REALTIME_TIMEOUT_MS,
    }),
  };
  return cached;
}

export function resetProvidersForTests() {
  cached = undefined;
}

export type {
  AssessmentProvider,
  AudioStorageProvider,
  TranscriptionProvider,
  TextToSpeechProvider,
};
