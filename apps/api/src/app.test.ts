import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_AUDIO_BYTES } from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { buildApp, MULTIPART_REQUEST_MARGIN_BYTES, requestBodyLimit } from "./app";
import { env } from "./env";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ...env(), MAX_UPLOAD_BYTES: MAX_AUDIO_BYTES });
});

afterAll(async () => {
  await app.close();
});

describe("API boundary", () => {
  test("uses a 30 MiB default body budget and grows with the file limit", () => {
    expect(app.initialConfig.bodyLimit).toBe(MAX_AUDIO_BYTES + MULTIPART_REQUEST_MARGIN_BYTES);

    const largerUploadLimit = MAX_AUDIO_BYTES * 2;
    expect(requestBodyLimit(largerUploadLimit)).toBe(
      largerUploadLimit + MULTIPART_REQUEST_MARGIN_BYTES,
    );
  });

  test("returns safe validation errors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      payload: { deviceId: "x" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).not.toContain("DATABASE_URL");
    expect(body.requestId).toBeTruthy();
  });

  test("never reflects a Daily Story provider key through validation details", async () => {
    const key = "sk-daily-story-validation-secret";
    const response = await app.inject({
      method: "POST",
      url: "/api/daily-story/provider-check",
      payload: {
        capability: "asr",
        provider: {
          baseUrl: "https://api.example.com/v1",
          apiKey: "valid-provider-key",
          model: "whisper-1",
          // Zod enum errors normally repeat this supplied string.
          responseFormat: key,
        },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(key);
    expect(response.json().error.details).toBeUndefined();
  });

  test("protects learner-scoped routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/progress" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("rejects sync access when no personal sync token is configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/sync/conversations" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  test("returns a health response even when local postgres is down", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    expect(["up", "down"]).toContain(response.json().database);
  });

  test("separates liveness from database readiness", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe("ok");

    const summary = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    if (summary.json().database === "up") {
      expect(ready.statusCode).toBe(200);
      expect(ready.json().status).toBe("ready");
    } else {
      expect(ready.statusCode).toBe(503);
      expect(ready.json().error.code).toBe("database_failure");
    }
  });

  test("maps malformed JSON and unsupported content type to safe client errors", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("bad_request");

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("deviceId=x"),
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe("bad_request");
  });
});
