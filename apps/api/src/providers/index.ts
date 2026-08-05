import { env } from "../env";
import { createLocalAudioStorage } from "./local-storage";
import { createS3AudioStorage } from "./s3-storage";
import { createMockAssessmentProvider } from "./mock/assessment";
import { createMockTranscriptionProvider } from "./mock/transcription";
import { createMockTtsProvider } from "./mock/tts";
import { createOpenAICompatibleAssessmentProvider } from "./openai-assessment";
import { createOpenAICompatibleTranscriptionProvider } from "./openai-transcription";
import { createOpenAICompatibleTextToSpeech } from "./openai-text-to-speech";
import { createOpenAICompatibleTextModel } from "./openai-text-model";
import { createOpenAICompatibleSpeechToText } from "./openai-speech-to-text";
import { createStructuredGenerator } from "../capabilities/structured-generator";
import { createSpeechSynthesisService } from "../modules/speech-synthesis/service";
import { localLlmConfig } from "./llm-config";
import { createRealtimeProvider, type RealtimeProvider } from "./realtime";
import type { AssessmentProvider } from "./assessment";
import type { AudioStorageProvider } from "./storage";
import type { TranscriptionProvider } from "./transcription";
import type { TextToSpeechProvider } from "./tts";
import type { TextModel } from "../capabilities/text-model";
import type { StructuredGenerator } from "../capabilities/structured-generator";
import type { SpeechToText } from "../capabilities/speech-to-text";

export type Providers = {
  transcription: TranscriptionProvider;
  assessment: AssessmentProvider;
  tts: TextToSpeechProvider;
  storage: AudioStorageProvider;
  realtime: RealtimeProvider;
  textModel?: TextModel;
  structuredGenerator?: StructuredGenerator;
  speechToText?: SpeechToText;
};

/**
 * Single place where provider implementations are chosen from configuration.
 * Add new drivers here — nothing else in the codebase constructs a provider.
 * The composition root owns lifetime; this function never hides a process singleton.
 */
export function providers(config = env()): Providers {
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
    responseFormat: config.TRANSCRIPTION_RESPONSE_FORMAT,
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

  const textModel =
    config.ASSESSMENT_PROVIDER === "openai-compatible"
      ? createOpenAICompatibleTextModel(chat)
      : undefined;
  const structuredGenerator = textModel ? createStructuredGenerator(textModel) : undefined;
  const speechToText =
    config.TRANSCRIPTION_PROVIDER === "openai-compatible"
      ? createOpenAICompatibleSpeechToText(transcription)
      : undefined;

  return {
    transcription:
      config.TRANSCRIPTION_PROVIDER === "openai-compatible"
        ? createOpenAICompatibleTranscriptionProvider(transcription, storage)
        : createMockTranscriptionProvider(),
    assessment:
      config.ASSESSMENT_PROVIDER === "openai-compatible"
        ? createOpenAICompatibleAssessmentProvider(chat, {
            model: textModel,
            generator: structuredGenerator,
          })
        : createMockAssessmentProvider(),
    tts:
      config.TTS_PROVIDER === "openai-compatible"
        ? createSpeechSynthesisService({
            textToSpeech: createOpenAICompatibleTextToSpeech(tts),
            storage,
            model: tts.model ?? "openai-compatible",
            defaultVoice: tts.voice,
          })
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
    textModel,
    structuredGenerator,
    speechToText,
  };
}

/** @deprecated Kept as source compatibility for older tests; providers are no longer cached. */
export function resetProvidersForTests() {
  // No hidden provider state to reset.
}

export type {
  AssessmentProvider,
  AudioStorageProvider,
  TranscriptionProvider,
  TextToSpeechProvider,
  TextModel,
  StructuredGenerator,
  SpeechToText,
};
