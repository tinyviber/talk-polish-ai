import {
  errorResponseSchema,
  listPromptsQuerySchema,
  promptsResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { listPrompts } from "./service";

export async function promptRoutes(app: FastifyInstance) {
  app.get(
    "/api/prompts",
    {
      schema: {
        tags: ["prompts"],
        summary: "List practice prompts, optionally filtered by language",
        querystring: listPromptsQuerySchema,
        response: { 200: promptsResponseSchema, 503: errorResponseSchema },
      },
    },
    async (request) => {
      const query = listPromptsQuerySchema.parse(request.query);
      return { prompts: await listPrompts(query.lang), requestId: request.id };
    },
  );
}
