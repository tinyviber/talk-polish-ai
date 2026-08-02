import {
  deleteSavedExpressionResponseSchema,
  errorResponseSchema,
  idParamsSchema,
  saveExpressionRequestSchema,
  savedExpressionResponseSchema,
  savedExpressionsResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireLearnerAuth } from "../../auth";
import { removeSavedExpression, listSavedExpressions, saveExpression } from "./service";

export async function expressionRoutes(app: FastifyInstance) {
  app.get(
    "/api/saved",
    {
      schema: {
        tags: ["saved"],
        summary: "List saved expressions for the authenticated learner",
        response: {
          200: savedExpressionsResponseSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      return { expressions: await listSavedExpressions(learner.id), requestId: request.id };
    },
  );

  app.post(
    "/api/saved",
    {
      schema: {
        tags: ["saved"],
        summary: "Save an expression for the authenticated learner",
        body: saveExpressionRequestSchema,
        response: {
          200: savedExpressionResponseSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const body = saveExpressionRequestSchema.parse(request.body);
      const expression = await saveExpression(learner.id, body.expression);
      return { expression, requestId: request.id };
    },
  );

  app.delete(
    "/api/saved/:id",
    {
      schema: {
        tags: ["saved"],
        summary: "Delete one saved expression",
        params: idParamsSchema,
        response: {
          200: deleteSavedExpressionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const learner = await requireLearnerAuth(request);
      const params = idParamsSchema.parse(request.params);
      await removeSavedExpression(learner.id, params.id);
      return { deleted: true, requestId: request.id };
    },
  );
}
