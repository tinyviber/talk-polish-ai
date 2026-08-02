import { errorResponseSchema, progressResponseSchema } from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireLearnerAuth } from "../../auth";
import { getProgress } from "./service";

export async function progressRoutes(app: FastifyInstance) {
  app.get(
    "/api/progress",
    {
      schema: {
        tags: ["progress"],
        summary: "Get progress for the authenticated learner",
        response: {
          200: progressResponseSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      return { progress: await getProgress(learner.id), requestId: request.id };
    },
  );
}
