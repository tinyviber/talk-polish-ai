import { and, eq } from "drizzle-orm";
import type { Env } from "../../env";
import {
  type ProviderDiagnostics,
  type RealtimeSmokeResponse,
  type SynthesisRequest,
} from "@kotoba/contracts";
import { db } from "../../db/client";
import { audioRecordings, speakingAttempts } from "../../db/schema";
import { withDb } from "../../http/with-db";
import { ApiError } from "../../http/errors";
import { providers, type Providers } from "../../providers";
import { diagnoseProviders } from "../../providers/diagnostics";
import { safeProviderError } from "../../providers/http";
import { StorageError } from "../../providers/storage";
import { issueAudioReference, resolveAudioReference } from "./audio-references";
import { enforceProviderRateLimit } from "./rate-limit";
import { removeOrQueueStorage } from "../../db/storage-cleanup";

export type ProviderApplication = ReturnType<typeof createProviderApplication>;

/** Application boundary for provider capability, TTS, audio, and realtime use cases. */
export function createProviderApplication(config: Env, providerSet: Providers = providers(config)) {
  return {
    diagnose(requestId: string) {
      return diagnoseProviders(requestId, config.DIAGNOSTICS_ACTIVE_PROBE, config, providerSet);
    },

    async synthesize(learnerId: string, input: SynthesisRequest, requestId: string, clientIp?: string) {
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
      } catch (error) {
        throw ApiError.processingUnavailable(
          `Text-to-speech is temporarily unavailable (${safeProviderError(error)}).`,
        );
      }
    },

    async playbackRecording(learnerId: string, audioId: string) {
      const rows = await withDb("loadAudioForPlayback", () =>
        db()
          .select({ storageKey: audioRecordings.storageKey, mimeType: audioRecordings.mimeType })
          .from(audioRecordings)
          .innerJoin(speakingAttempts, eq(speakingAttempts.audioId, audioRecordings.id))
          .where(and(eq(audioRecordings.id, audioId), eq(speakingAttempts.learnerId, learnerId))),
      );
      const audio = rows[0];
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
