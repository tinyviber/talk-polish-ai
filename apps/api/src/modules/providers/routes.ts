import {
  errorResponseSchema,
  idParamsSchema,
  providerDiagnosticsSchema,
  realtimeSmokeResponseSchema,
  synthesisRequestSchema,
  synthesisResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireLearnerAuth } from "../../auth";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { env } from "../../env";
import { ApiError } from "../../http/errors";
import { withDb } from "../../http/with-db";
import { audioRecordings, speakingAttempts } from "../../db/schema";
import { safeProviderError } from "../../providers/http";
import { diagnoseProviders } from "../../providers/diagnostics";
import { providers } from "../../providers";
import { StorageError } from "../../providers/storage";
import { issueAudioReference, resolveAudioReference } from "./audio-references";
import { enforceProviderRateLimit } from "./rate-limit";
import { removeOrQueueStorage } from "../../db/storage-cleanup";
import { z } from "zod";

export async function providerRoutes(app: FastifyInstance) {
  app.get(
    "/api/providers/diagnostics",
    {
      schema: {
        tags: ["providers"],
        summary: "Authenticated provider capability diagnostics",
        querystring: z.object({ probe: z.enum(["true", "false"]).optional() }),
        response: {
          200: providerDiagnosticsSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      if (env().DIAGNOSTICS_ACTIVE_PROBE)
        enforceProviderRateLimit(learner.id, "diagnostics", request.ip);
      // Query flag is intentionally ignored. Active probes require server-side opt-in.
      return diagnoseProviders(request.id, env().DIAGNOSTICS_ACTIVE_PROBE);
    },
  );

  app.post(
    "/api/tts",
    {
      schema: {
        tags: ["providers"],
        summary: "Generate and cache authenticated TTS audio",
        body: synthesisRequestSchema,
        response: {
          200: synthesisResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      enforceProviderRateLimit(learner.id, "tts", request.ip);
      const input = synthesisRequestSchema.parse(request.body);
      try {
        const result = await providers().tts.synthesize({ ...input, scope: learner.id });
        let reference: string | null = null;
        try {
          reference = result.storageKey
            ? await issueAudioReference(
                learner.id,
                result.storageKey,
                result.contentType ?? "audio/mpeg",
              )
            : null;
        } catch (error) {
          if (result.storageKey) {
            await removeOrQueueStorage(
              providers().storage,
              result.storageKey,
              "tts-reference-failed",
            );
          }
          throw error;
        }
        return {
          requestId: request.id,
          audio: {
            playbackUrl: reference ? `/api/audio/${reference}` : null,
            seconds: result.seconds,
            provider: result.provider,
          },
        };
      } catch (error) {
        request.log.warn({ providerError: safeProviderError(error) }, "tts failed");
        throw ApiError.processingUnavailable("Text-to-speech is temporarily unavailable.");
      }
    },
  );

  app.get(
    "/api/audio/recordings/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Authenticated playback for learner-owned recording",
        params: idParamsSchema,
        response: { 401: errorResponseSchema, 404: errorResponseSchema, 503: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const learner = await requireLearnerAuth(request);
      const { id } = idParamsSchema.parse(request.params);
      const rows = await withDb("loadAudioForPlayback", () =>
        db()
          .select({ storageKey: audioRecordings.storageKey, mimeType: audioRecordings.mimeType })
          .from(audioRecordings)
          .innerJoin(speakingAttempts, eq(speakingAttempts.audioId, audioRecordings.id))
          .where(and(eq(audioRecordings.id, id), eq(speakingAttempts.learnerId, learner.id))),
      );
      const audio = rows[0];
      if (!audio) throw ApiError.notFound("Audio");
      let content: Buffer | null;
      try {
        content = await providers().storage.get(audio.storageKey);
      } catch (error) {
        if (error instanceof StorageError) throw ApiError.storage();
        throw error;
      }
      if (!content) throw ApiError.notFound("Audio");
      return reply
        .type(audio.mimeType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(content);
    },
  );

  app.get(
    "/api/audio/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Authenticated backend audio playback",
        params: idParamsSchema,
        response: { 401: errorResponseSchema, 404: errorResponseSchema, 503: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const learner = await requireLearnerAuth(request);
      const { id } = idParamsSchema.parse(request.params);
      const audio = await resolveAudioReference(id, learner.id);
      if (!audio) throw ApiError.notFound("Audio");
      let content: Buffer | null;
      try {
        content = await providers().storage.get(audio.storageKey);
      } catch (error) {
        if (error instanceof StorageError) throw ApiError.storage();
        throw error;
      }
      if (!content) throw ApiError.notFound("Audio");
      return reply
        .type(audio.mimeType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(content);
    },
  );

  app.post(
    "/api/realtime/experimental/smoke",
    {
      schema: {
        tags: ["providers"],
        summary: "Feature-flagged Realtime protocol smoke test",
        response: {
          200: realtimeSmokeResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const realtime = providers().realtime;
      if (!env().REALTIME_FEATURE_ENABLED) {
        return {
          capability: "realtime" as const,
          status: "unsupported" as const,
          provider: realtime.name,
          protocol: "websocket" as const,
          requestId: request.id,
        };
      }
      try {
        enforceProviderRateLimit(learner.id, "realtime", request.ip);
        await realtime.smokeTest(request.id);
        return {
          capability: "realtime" as const,
          status: "available" as const,
          provider: realtime.name,
          protocol: "websocket" as const,
          requestId: request.id,
        };
      } catch (error) {
        return {
          capability: "realtime" as const,
          status: "failed" as const,
          provider: realtime.name,
          protocol: "websocket" as const,
          errorCode: safeProviderError(error),
          requestId: request.id,
        };
      }
    },
  );
}
