import {
  DAILY_STORY_LIMITS,
  SUPPORTED_AUDIO_MIME_TYPES,
  dailyStoryAsrConfigSchema,
  dailyStoryProviderCheckRequestSchema,
  dailyStoryProviderCheckResponseSchema,
  dailyStoryReplyRequestSchema,
  dailyStoryReplyResponseSchema,
  dailyStoryReviewRequestSchema,
  dailyStoryReviewResponseSchema,
  dailyStoryStartRequestSchema,
  dailyStoryStartResponseSchema,
  dailyStoryTranscribeResponseSchema,
  dailyStoryTtsRequestSchema,
  errorResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { requireLearnerAuth } from "../../auth";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { createDailyStoryService, type DailyStoryService } from "./service";

export async function dailyStoryRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { config: Env; service?: DailyStoryService },
) {
  const service = options.service ?? createDailyStoryService(options.config);

  app.post(
    "/api/daily-story/start",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Start a Daily Story conversation",
        body: dailyStoryStartRequestSchema,
        response: {
          200: dailyStoryStartResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = dailyStoryStartRequestSchema.parse(request.body);
      const result = await service.start({
        ...body,
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
      });
      return { ...result, requestId: request.id };
    },
  );

  app.post(
    "/api/daily-story/transcribe",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Faithfully transcribe one Daily Story recording",
        response: {
          200: dailyStoryTranscribeResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          413: errorResponseSchema,
          415: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const multipart = await readDailyStoryMultipart(request);
      const result = await service.transcribe({
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
        asr: multipart.asr,
        audio: multipart.audio,
        mimeType: multipart.mimeType,
      });
      return { ...result, requestId: request.id };
    },
  );

  app.post(
    "/api/daily-story/reply",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Continue a Daily Story conversation",
        body: dailyStoryReplyRequestSchema,
        response: {
          200: dailyStoryReplyResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = dailyStoryReplyRequestSchema.parse(request.body);
      const result = await service.reply({
        ...body,
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
      });
      return { ...result, requestId: request.id };
    },
  );

  app.post(
    "/api/daily-story/review",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Review finished Daily Story conversation",
        body: dailyStoryReviewRequestSchema,
        response: {
          200: dailyStoryReviewResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = dailyStoryReviewRequestSchema.parse(request.body);
      const result = await service.review({
        ...body,
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
      });
      return { ...result, requestId: request.id };
    },
  );

  app.post(
    "/api/daily-story/tts",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Synthesize uncached Daily Story audio",
        body: dailyStoryTtsRequestSchema,
        response: {
          401: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const learner = await requireLearnerAuth(request);
      const body = dailyStoryTtsRequestSchema.parse(request.body);
      const audio = await service.tts({
        ...body,
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
      });
      return reply
        .type(audio.contentType)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(audio.bytes);
    },
  );

  app.post(
    "/api/daily-story/provider-check",
    {
      schema: {
        tags: ["daily-story"],
        summary: "Check one request-scoped Daily Story provider",
        body: dailyStoryProviderCheckRequestSchema,
        response: {
          200: dailyStoryProviderCheckResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = dailyStoryProviderCheckRequestSchema.parse(request.body);
      if (options.config.NODE_ENV !== "production") {
        request.log.info(
          {
            capability: body.capability,
            providerBaseUrl: body.provider.baseUrl,
            providerModel: body.provider.model,
            hasApiKey: body.provider.apiKey.length > 0,
          },
          "daily-story provider check",
        );
      }
      const result = await service.providerCheck({
        learnerId: learner.id,
        ip: request.ip,
        requestId: request.id,
        request: body,
      });
      return { ...result, requestId: request.id };
    },
  );
}

async function readDailyStoryMultipart(request: FastifyRequest) {
  let audio: Uint8Array | undefined;
  let mimeType: string | undefined;
  let asrRaw: string | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "audio" || audio)
          throw ApiError.badRequest("Daily Story requires exactly one audio file.");
        const normalizedMime = part.mimetype.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (!(SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
          throw ApiError.unsupportedMedia("Unsupported Daily Story audio format.");
        }
        const buffer = await part.toBuffer();
        if (buffer.byteLength === 0) throw ApiError.badRequest("Daily Story audio is empty.");
        if (buffer.byteLength > DAILY_STORY_LIMITS.audioBytes) {
          throw ApiError.tooLarge("Daily Story audio is too large.");
        }
        audio = new Uint8Array(buffer);
        mimeType = normalizedMime;
      } else {
        if (part.fieldname !== "asr" || asrRaw !== undefined) {
          throw ApiError.badRequest("Daily Story multipart fields are invalid.");
        }
        asrRaw = String(part.value);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isMultipartLimitError(error)) throw ApiError.tooLarge("Daily Story audio is too large.");
    throw ApiError.badRequest("Daily Story recording could not be read.");
  }
  if (!audio || !mimeType || !asrRaw)
    throw ApiError.badRequest("Daily Story requires audio and ASR settings.");
  let asrJson: unknown;
  try {
    asrJson = JSON.parse(asrRaw);
  } catch {
    throw ApiError.validation("Daily Story ASR settings are invalid.");
  }
  const parsedAsr = dailyStoryAsrConfigSchema.safeParse(asrJson);
  if (!parsedAsr.success) throw ApiError.validation("Daily Story ASR settings are invalid.");
  return { audio, mimeType, asr: parsedAsr.data };
}

function isMultipartLimitError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_REQ_BODY_TOO_LARGE")
  );
}
