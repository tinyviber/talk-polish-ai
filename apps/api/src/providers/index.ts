import { env } from "../env";
import { createLocalAudioStorage } from "./local-storage";
import { createMockAssessmentProvider } from "./mock/assessment";
import { createMockTranscriptionProvider } from "./mock/transcription";
import { createMockTtsProvider } from "./mock/tts";
import type { AssessmentProvider } from "./assessment";
import type { AudioStorageProvider } from "./storage";
import type { TranscriptionProvider } from "./transcription";
import type { TextToSpeechProvider } from "./tts";

export type Providers = {
  transcription: TranscriptionProvider;
  assessment: AssessmentProvider;
  tts: TextToSpeechProvider;
  storage: AudioStorageProvider;
};

let cached: Providers | undefined;

/**
 * Single place where provider implementations are chosen from configuration.
 * Add new drivers here — nothing else in the codebase constructs a provider.
 */
export function providers(): Providers {
  if (cached) return cached;
  const config = env();

  if (config.AUDIO_STORAGE_DRIVER === "s3") {
    throw new Error(
      "AUDIO_STORAGE_DRIVER=s3 is not implemented yet — add an S3 AudioStorageProvider in apps/api/src/providers/",
    );
  }

  cached = {
    transcription: createMockTranscriptionProvider(),
    assessment: createMockAssessmentProvider(),
    tts: createMockTtsProvider(),
    storage: createLocalAudioStorage(config.DATA_DIR),
  };
  return cached;
}

export type { AssessmentProvider, AudioStorageProvider, TranscriptionProvider, TextToSpeechProvider };
