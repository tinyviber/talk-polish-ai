import {
  createAnonymousLearnerRequestSchema,
  errorResponseSchema,
  learnerResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { issueLearnerToken } from "../../auth";
import { upsertAnonymousLearner } from "./service";

export async function learnerRoutes(app: FastifyInstance) {
  app.post(
    "/api/learners/anonymous",
    {
      schema: {
        tags: ["learners"],
        summary: "Create or resume an anonymous learner profile for a device id",
        body: createAnonymousLearnerRequestSchema,
        response: {
          200: learnerResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const body = createAnonymousLearnerRequestSchema.parse(request.body);
      const learner = await upsertAnonymousLearner(body.deviceId, body.lang ?? null);
      return { learner, token: issueLearnerToken(learner.id), requestId: request.id };
    },
  );
}
