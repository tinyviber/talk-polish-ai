import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";

const integration = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
const ttsIntegration =
  process.env.RUN_INTEGRATION === "1" && process.env.RUN_TTS_INTEGRATION === "1" ? test : test.skip;
let app: FastifyInstance;
let ttsFixture: ReturnType<typeof Bun.serve> | undefined;

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
  if (process.env.RUN_TTS_INTEGRATION === "1") {
    process.env.TTS_PROVIDER = "openai-compatible";
    process.env.TTS_API_KEY = "integration-fixture-key";
    process.env.TTS_MODEL = "integration-tts";
    ttsFixture = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (request.headers.get("authorization") !== "Bearer integration-fixture-key") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (new URL(request.url).pathname !== "/audio/speech") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return new Response(Buffer.from("integration tts"), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });
    process.env.TTS_BASE_URL = ttsFixture.url.origin;
  }
  if (process.env.RUN_INTEGRATION === "1") app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  ttsFixture?.stop(true);
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
    const clientAttemptId = `client-${crypto.randomUUID()}`;
    const firstUpload = multipart({ clientAttemptId, attemptIndex: "1", durationSec: "12" }, audio);
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
    expect(first.audio.playbackUrl).toBe(`/api/audio/recordings/${first.audio.id}`);
    expect(first.audio).not.toHaveProperty("storageKey");
    expect(first.feedback).toBeTruthy();

    // A lost response followed by the same multipart upload must return the
    // existing attempt, not create another audio object or progress event.
    const replayUpload = multipart(
      { clientAttemptId, attemptIndex: "1", durationSec: "12" },
      audio,
    );
    const replayResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attempts`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": replayUpload.contentType,
      },
      payload: replayUpload.body,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().attempt.id).toBe(first.id);

    const recoveredSession = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(recoveredSession.statusCode).toBe(200);
    expect(recoveredSession.json().session.attempts).toHaveLength(1);

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

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/providers/diagnostics?probe=true",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    const diagnostics = diagnosticsResponse.json();
    expect(diagnostics.storage.status).toMatch(/^(configured|available)$/);
    expect(diagnostics.database.status).toBe("available");
    expect(diagnostics.chat.status).toBe("available");
    expect(diagnostics.transcription.status).toBe("available");
    expect(JSON.stringify(diagnostics)).not.toContain("minioadmin");
  });

  ttsIntegration("generates, stores, and plays authenticated TTS audio", async () => {
    const deviceId = `tts-integration-${crypto.randomUUID()}`;
    const learnerResponse = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      payload: { deviceId, lang: "en" },
    });
    const { token } = learnerResponse.json();
    const ttsResponse = await app.inject({
      method: "POST",
      url: "/api/tts",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "A clear sample answer.", lang: "en", purpose: "answer" },
    });
    expect(ttsResponse.statusCode).toBe(200);
    const audio = ttsResponse.json().audio;
    expect(audio.playbackUrl).toMatch(/^\/api\/audio\//);

    const playbackResponse = await app.inject({
      method: "GET",
      url: audio.playbackUrl,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(playbackResponse.statusCode).toBe(200);
    expect(playbackResponse.headers["content-type"]).toContain("audio/mpeg");
    expect(Buffer.from(playbackResponse.rawPayload)).toEqual(Buffer.from("integration tts"));
  });
});
