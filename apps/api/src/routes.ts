import {
  errorResponseSchema,
  healthResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { pingDatabase } from "./db/client";
import { ApiError } from "./http/errors";
import { expressionRoutes } from "./modules/expressions/routes";
import { learnerRoutes } from "./modules/learners/routes";
import { attemptRoutes } from "./modules/attempts/routes";
import { progressRoutes } from "./modules/progress/routes";
import { promptRoutes } from "./modules/prompts/routes";
import { sessionRoutes } from "./modules/sessions/routes";
import { providerRoutes } from "./modules/providers/routes";

export async function registerRoutes(app: FastifyInstance) {
  const health = async (request: { id: string }) => ({
    status: "ok" as const,
    uptimeSec: Math.round(process.uptime() * 10) / 10,
    version: process.env.npm_package_version ?? "0.1.0",
    database: (await pingDatabase()) ? ("up" as const) : ("down" as const),
    requestId: request.id,
  });

  const liveness = async (request: { id: string }) => ({
    status: "ok" as const,
    uptimeSec: Math.round(process.uptime() * 10) / 10,
    version: process.env.npm_package_version ?? "0.1.0",
    requestId: request.id,
  });

  const readiness = async (request: { id: string }) => {
    if (!(await pingDatabase())) throw ApiError.database("PostgreSQL is not ready.");
    return { status: "ready" as const, database: "up" as const, requestId: request.id };
  };

  for (const path of ["/health", "/api/health"]) {
    app.get(path, {
      schema: {
        tags: ["system"],
        summary: "API and database health",
        response: { 200: healthResponseSchema, 503: errorResponseSchema },
      },
      handler: health,
    });
  }

  for (const path of ["/health/live", "/api/health/live"]) {
    app.get(path, {
      schema: {
        tags: ["system"],
        summary: "Liveness probe; does not require PostgreSQL",
        response: { 200: livenessResponseSchema, 503: errorResponseSchema },
      },
      handler: liveness,
    });
  }

  for (const path of ["/health/ready", "/api/health/ready"]) {
    app.get(path, {
      schema: {
        tags: ["system"],
        summary: "Readiness probe; requires PostgreSQL",
        response: { 200: readinessResponseSchema, 503: errorResponseSchema },
      },
      handler: readiness,
    });
  }

  await app.register(learnerRoutes);
  await app.register(promptRoutes);
  await app.register(sessionRoutes);
  await app.register(attemptRoutes);
  await app.register(expressionRoutes);
  await app.register(progressRoutes);
  await app.register(providerRoutes);
}
