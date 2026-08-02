import {
  attemptResponseSchema,
  createAttemptFieldsSchema,
  errorResponseSchema,
  idParamsSchema,
  sessionIdParamsSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireLearnerAuth } from "../../auth";
import { ApiError } from "../../http/errors";
import { createAttempt, type UploadedAudio } from "./service";
import { getAttempt } from "../sessions/service";

export async function attemptRoutes(app: FastifyInstance) {
  app.post(
    "/api/sessions/:sessionId/attempts",
    {
      schema: {
        tags: ["attempts"],
        summary: "Upload an audio attempt and return its transcript and feedback",
        params: sessionIdParamsSchema,
        response: {
          200: attemptResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          413: errorResponseSchema,
          415: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const params = sessionIdParamsSchema.parse(request.params);
      const fields: Record<string, string> = {};
      let audio: UploadedAudio | null = null;

      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (audio) throw ApiError.badRequest("Only one audio file may be uploaded.");
            const buffer = await part.toBuffer();
            audio = { buffer, mimeType: part.mimetype, filename: part.filename };
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isMultipartLimitError(error)) {
          throw ApiError.tooLarge("The recording is larger than the configured upload limit.");
        }
        throw ApiError.badRequest("The multipart recording could not be read.");
      }

      const parsed = createAttemptFieldsSchema.safeParse(fields);
      if (!parsed.success) {
        throw ApiError.validation(
          "Attempt fields are invalid.",
          parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        );
      }
      const attempt = await createAttempt(params.sessionId, learner.id, parsed.data, audio);
      return { attempt, requestId: request.id };
    },
  );

  app.get(
    "/api/attempts/:id",
    {
      schema: {
        tags: ["attempts"],
        summary: "Get one authenticated learner attempt",
        params: idParamsSchema,
        response: {
          200: attemptResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const params = idParamsSchema.parse(request.params);
      const attempt = await getAttempt(params.id, learner.id);
      return { attempt, requestId: request.id };
    },
  );
}

function isMultipartLimitError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_REQ_BODY_TOO_LARGE")
  );
}
