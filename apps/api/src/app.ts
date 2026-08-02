import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "./env";
import { closeDatabase } from "./db/client";
import { ApiError, toErrorResponse } from "./http/errors";
import { registerRoutes } from "./routes";

export async function buildApp() {
  const config = env();
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-api-key",
          "req.body",
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin:
      config.CORS_ORIGIN === "*"
        ? true
        : config.CORS_ORIGIN.split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 },
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(toErrorResponse(ApiError.notFound("Route"), request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.code === "rate_limited") reply.header("Retry-After", "60");
      reply.status(error.statusCode).send(toErrorResponse(error, request.id));
      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => issue.message);
      const validation = ApiError.validation("Request validation failed.", details);
      reply.status(validation.statusCode).send(toErrorResponse(validation, request.id));
      return;
    }

    if (isPayloadTooLarge(error)) {
      const tooLarge = ApiError.tooLarge("The request payload is too large.");
      reply.status(tooLarge.statusCode).send(toErrorResponse(tooLarge, request.id));
      return;
    }

    request.log.error(error);
    const internal = ApiError.internal();
    reply.status(internal.statusCode).send(toErrorResponse(internal, request.id));
  });

  await registerRoutes(app);
  app.addHook("onClose", async () => {
    await closeDatabase();
  });
  return app;
}

function isPayloadTooLarge(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || error.code === "FST_REQ_BODY_TOO_LARGE")
  );
}
