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
import { getSynthesisStorageDisposition } from "../../providers/tts";
import { issueAudioReference, resolveAudioReference } from "./audio-references";
import { enforceProviderRateLimit } from "./rate-limit";
import { ORPHAN_STORAGE_GRACE_MS, removeOrQueueStorage } from "../../db/storage-cleanup";
import { providerRepository } from "./repository";

export type ProviderApplication = ReturnType<typeof createProviderApplication>;
type ProviderApplicationDependencies = {
  diagnoseProviders: typeof diagnoseProviders;
  enforceProviderRateLimit: typeof enforceProviderRateLimit;
  issueAudioReference: typeof issueAudioReference;
  resolveAudioReference: typeof resolveAudioReference;
  removeOrQueueStorage: typeof removeOrQueueStorage;
  providerRepository: Pick<typeof providerRepository, "findRecordingForLearner">;
};

/** Application boundary for provider capability, TTS, audio, and realtime use cases. */
export function createProviderApplication(
  config: Env,
  providerSet: Providers = providers(config),
  overrides: Partial<ProviderApplicationDependencies> = {},
) {
  const deps: ProviderApplicationDependencies = {
    diagnoseProviders,
    enforceProviderRateLimit,
    issueAudioReference,
    resolveAudioReference,
    removeOrQueueStorage,
    providerRepository,
    ...overrides,
  };

  return {
    diagnose(
      learnerId: string,
      requestId: string,
      clientIp?: string,
      activeProbeRequested = false,
    ) {
      const activeProbe = config.DIAGNOSTICS_ACTIVE_PROBE && activeProbeRequested;
      if (activeProbe) deps.enforceProviderRateLimit(learnerId, "diagnostics", clientIp);
      return deps.diagnoseProviders(requestId, activeProbe, config, providerSet);
    },

    async synthesize(
      learnerId: string,
      input: SynthesisRequest,
      requestId: string,
      clientIp?: string,
    ) {
      deps.enforceProviderRateLimit(learnerId, "tts", clientIp);
      try {
        const result = await providerSet.tts.synthesize({ ...input, scope: learnerId });
        let reference: string | null = null;
        try {
          reference = result.storageKey
            ? await deps.issueAudioReference(
                learnerId,
                result.storageKey,
                result.contentType ?? "audio/mpeg",
              )
            : null;
        } catch (error) {
          if (result.storageKey && getSynthesisStorageDisposition(result) !== "cache-hit") {
            await deps.removeOrQueueStorage(
              providerSet.storage,
              result.storageKey,
              "tts-reference-failed",
              new Date(Date.now() + ORPHAN_STORAGE_GRACE_MS),
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
      const audio = await deps.providerRepository.findRecordingForLearner(learnerId, audioId);
      if (!audio) throw ApiError.notFound("Audio");
      return readAudio(providerSet, audio.storageKey, audio.mimeType);
    },

    async playbackReference(learnerId: string, referenceId: string) {
      const audio = await deps.resolveAudioReference(referenceId, learnerId);
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
        deps.enforceProviderRateLimit(learnerId, "realtime", clientIp);
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
