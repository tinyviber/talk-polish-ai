import {
  createPracticeSessionRequestSchema,
  errorResponseSchema,
  idParamsSchema,
  practiceSessionResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireLearnerAuth } from "../../auth";
import { createPracticeSession, getPracticeSession } from "./service";

export async function sessionRoutes(app: FastifyInstance) {
  app.post(
    "/api/sessions",
    {
      schema: {
        tags: ["sessions"],
        summary: "Create a practice session for the authenticated learner",
        body: createPracticeSessionRequestSchema,
        response: {
          200: practiceSessionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = createPracticeSessionRequestSchema.parse(request.body);
      const session = await createPracticeSession(learner.id, body.promptId);
      return { session, requestId: request.id };
    },
  );

  app.get(
    "/api/sessions/:id",
    {
      schema: {
        tags: ["sessions"],
        summary: "Get a practice session and its attempts",
        params: idParamsSchema,
        response: {
          200: practiceSessionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const params = idParamsSchema.parse(request.params);
      const session = await getPracticeSession(params.id, learner.id);
      return { session, requestId: request.id };
    },
  );
}
