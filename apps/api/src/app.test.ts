import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe("API boundary", () => {
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

  test("protects learner-scoped routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/progress" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
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
