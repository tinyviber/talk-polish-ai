import type { Env } from "../../env";
import {
  type ProviderDiagnostics,
  type RealtimeSmokeResponse,
  type SynthesisRequest,
} from "@kotoba/contracts";
import { ApiError } from "../../http/errors";
import { providers, type Providers } from "../../providers";
import { diagnoseProviders } from "../../providers/diagnostics";
import { safeProviderError } from "../../providers/http";
import { StorageError } from "../../providers/storage";
import { issueAudioReference, resolveAudioReference } from "./audio-references";
import { enforceProviderRateLimit } from "./rate-limit";
import { removeOrQueueStorage } from "../../db/storage-cleanup";
import { providerRepository } from "./repository";

export type ProviderApplication = ReturnType<typeof createProviderApplication>;

/** Application boundary for provider capability, TTS, audio, and realtime use cases. */
export function createProviderApplication(config: Env, providerSet: Providers = providers(config)) {
  return {
    diagnose(requestId: string) {
      return diagnoseProviders(requestId, config.DIAGNOSTICS_ACTIVE_PROBE, config, providerSet);
    },

    async synthesize(
      learnerId: string,
      input: SynthesisRequest,
      requestId: string,
      clientIp?: string,
    ) {
      enforceProviderRateLimit(learnerId, "tts", clientIp);
      try {
        const result = await providerSet.tts.synthesize({ ...input, scope: learnerId });
        let reference: string | null = null;
        try {
          reference = result.storageKey
            ? await issueAudioReference(
                learnerId,
                result.storageKey,
                result.contentType ?? "audio/mpeg",
              )
            : null;
        } catch (error) {
          if (result.storageKey) {
            await removeOrQueueStorage(
              providerSet.storage,
              result.storageKey,
              "tts-reference-failed",
            );
          }
          throw error;
        }
        return {
          requestId,
          audio: {
            playbackUrl: reference ? `/api/audio/${reference}` : null,
            seconds: result.seconds,
            provider: result.provider,
          },
        };
      } catch {
        throw ApiError.processingUnavailable("Text-to-speech is temporarily unavailable.");
      }
    },

    async playbackRecording(learnerId: string, audioId: string) {
      const audio = await providerRepository.findRecordingForLearner(learnerId, audioId);
      if (!audio) throw ApiError.notFound("Audio");
      return readAudio(providerSet, audio.storageKey, audio.mimeType);
    },

    async playbackReference(learnerId: string, referenceId: string) {
      const audio = await resolveAudioReference(referenceId, learnerId);
      if (!audio) throw ApiError.notFound("Audio");
      return readAudio(providerSet, audio.storageKey, audio.mimeType);
    },

    async realtimeSmoke(
      learnerId: string,
      requestId: string,
      clientIp?: string,
    ): Promise<RealtimeSmokeResponse> {
      if (!config.REALTIME_FEATURE_ENABLED) {
        return {
          capability: "realtime",
          status: "unsupported",
          provider: providerSet.realtime.name,
          protocol: "websocket",
          requestId,
        };
      }
      try {
        enforceProviderRateLimit(learnerId, "realtime", clientIp);
        await providerSet.realtime.smokeTest(requestId);
        return {
          capability: "realtime",
          status: "available",
          provider: providerSet.realtime.name,
          protocol: "websocket",
          requestId,
        };
      } catch (error) {
        return {
          capability: "realtime",
          status: "failed",
          provider: providerSet.realtime.name,
          protocol: "websocket",
          errorCode: safeProviderError(error),
          requestId,
        };
      }
    },
  };
}

async function readAudio(providerSet: Providers, storageKey: string, mimeType: string) {
  let content: Buffer | null;
  try {
    content = await providerSet.storage.get(storageKey);
  } catch (error) {
    if (error instanceof StorageError) throw ApiError.storage();
    throw error;
  }
  if (!content) throw ApiError.notFound("Audio");
  return { content, mimeType };
}
