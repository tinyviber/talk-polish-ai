import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";

const integration = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
let app: FastifyInstance;

function multipart(fields: Record<string, string>, audio: Buffer) {
  const boundary = `----kotoba-${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="answer.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION === "1") app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe("persisted practice journey", () => {
  integration("creates learner, session, attempts, saved expression and progress", async () => {
    const deviceId = `integration-${crypto.randomUUID()}`;
    const learnerResponse = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      payload: { deviceId, lang: "en" },
    });
    expect(learnerResponse.statusCode).toBe(200);
    const { learner, token } = learnerResponse.json();
    expect(learner.id).toMatch(/^lnr_/);
    expect(token).toBeTruthy();

    const promptsResponse = await app.inject({
      method: "GET",
      url: "/api/prompts?lang=en",
    });
    expect(promptsResponse.statusCode).toBe(200);
    const prompt = promptsResponse.json().prompts[0];

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { promptId: prompt.id },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json().session;

    const audio = Buffer.from("deterministic integration audio");
    const firstUpload = multipart({ attemptIndex: "1", durationSec: "12" }, audio);
    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attempts`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": firstUpload.contentType,
      },
      payload: firstUpload.body,
    });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json().attempt;
    expect(first.status).toBe("ready");
    expect(first.audio.storageKey).toMatch(/^local:\/\/recordings\//);
    expect(first.feedback).toBeTruthy();

    const secondUpload = multipart({ attemptIndex: "2", durationSec: "12" }, audio);
    const secondResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attempts`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": secondUpload.contentType,
      },
      payload: secondUpload.body,
    });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json().attempt;
    expect(second.status).toBe("ready");
    expect(second.feedback.overall).toBeGreaterThan(first.feedback.overall);

    const expression = first.feedback.expressions[0];
    const savedResponse = await app.inject({
      method: "POST",
      url: "/api/saved",
      headers: { authorization: `Bearer ${token}` },
      payload: { expression },
    });
    expect(savedResponse.statusCode).toBe(200);

    const progressResponse = await app.inject({
      method: "GET",
      url: "/api/progress",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(progressResponse.statusCode).toBe(200);
    const progress = progressResponse.json().progress;
    expect(progress.totalSessions).toBeGreaterThanOrEqual(1);
    expect(progress.sessions[0].second).toBeGreaterThan(progress.sessions[0].first);
    expect(progress.savedCount).toBeGreaterThanOrEqual(1);
  });
});
