import {
  errorResponseSchema,
  idParamsSchema,
  providerDiagnosticsSchema,
  realtimeSmokeResponseSchema,
  synthesisRequestSchema,
  synthesisResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { requireLearnerAuth } from "../../auth";
import type { Env } from "../../env";
import { createProviderApplication } from "./service";
import { z } from "zod";

export async function providerRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { config: Env },
) {
  const service = createProviderApplication(options.config);

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
      await requireLearnerAuth(request);
      return service.diagnose(request.id);
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
      const input = synthesisRequestSchema.parse(request.body);
      return service.synthesize(learner.id, input, request.id, request.ip);
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
      const audio = await service.playbackRecording(learner.id, id);
      return reply
        .type(audio.mimeType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(audio.content);
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
      const audio = await service.playbackReference(learner.id, id);
      return reply
        .type(audio.mimeType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(audio.content);
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
      return service.realtimeSmoke(learner.id, request.id, request.ip);
    },
  );
}
