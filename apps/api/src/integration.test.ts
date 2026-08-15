import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import type { DailyStorySyncPushRequest } from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { db } from "./db/client";
import {
  audioRecordings,
  dailyStorySyncObjects,
  speakingAttempts,
  storageCleanupJobs,
} from "./db/schema";
import { ATTEMPT_PROCESSING_STALE_MS } from "./modules/attempts/service";
import { dailyStorySyncRepository, encodeSyncCursor } from "./modules/daily-story-sync/repository";

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

  integration("creates durable cleanup intent when stale processing is recovered", async () => {
    const deviceId = `stale-${crypto.randomUUID()}`;
    const learnerResponse = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      payload: { deviceId, lang: "en" },
    });
    const { learner, token } = learnerResponse.json();
    const prompt = (await app.inject({ method: "GET", url: "/api/prompts?lang=en" })).json()
      .prompts[0];
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { promptId: prompt.id, clientSessionId: `stale-session-${crypto.randomUUID()}` },
    });
    const session = sessionResponse.json().session;
    const staleAttemptId = `att_stale_${crypto.randomUUID()}`;
    const audioId = `aud_stale_${crypto.randomUUID()}`;
    const storageKey = `recordings/${learner.id}/${staleAttemptId}.webm`;

    await db().insert(audioRecordings).values({
      id: audioId,
      storageKey,
      mimeType: "audio/webm",
      sizeBytes: 12,
      durationSec: 1,
    });
    await db()
      .insert(speakingAttempts)
      .values({
        id: staleAttemptId,
        sessionId: session.id,
        learnerId: learner.id,
        attemptIndex: 1,
        clientAttemptId: null,
        status: "processing",
        durationSec: 1,
        mocked: false,
        audioId,
        createdAt: new Date(Date.now() - ATTEMPT_PROCESSING_STALE_MS - 1),
      });

    const getRecoveryAttemptId = `att_get_stale_${crypto.randomUUID()}`;
    const getRecoveryAudioId = `aud_get_stale_${crypto.randomUUID()}`;
    const getRecoveryClientAttemptId = `client-get-stale-${crypto.randomUUID()}`;
    const getRecoveryStorageKey = `recordings/${learner.id}/${getRecoveryAttemptId}.webm`;
    await db().insert(audioRecordings).values({
      id: getRecoveryAudioId,
      storageKey: getRecoveryStorageKey,
      mimeType: "audio/webm",
      sizeBytes: 12,
      durationSec: 1,
    });
    await db()
      .insert(speakingAttempts)
      .values({
        id: getRecoveryAttemptId,
        sessionId: session.id,
        learnerId: learner.id,
        attemptIndex: 2,
        clientAttemptId: getRecoveryClientAttemptId,
        status: "processing",
        durationSec: 1,
        mocked: false,
        audioId: getRecoveryAudioId,
        createdAt: new Date(Date.now() - ATTEMPT_PROCESSING_STALE_MS - 1),
      });

    const getRecoveryResponse = await app.inject({
      method: "GET",
      url: `/api/attempts/${getRecoveryAttemptId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRecoveryResponse.statusCode).toBe(200);
    expect(getRecoveryResponse.json().attempt.status).toBe("failed");

    const upload = multipart({ attemptIndex: "1", durationSec: "1" }, Buffer.from("new audio"));
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attempts`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": upload.contentType,
      },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("processing_unavailable");

    const failed = await db()
      .select({ status: speakingAttempts.status, audioId: speakingAttempts.audioId })
      .from(speakingAttempts)
      .where(eq(speakingAttempts.id, staleAttemptId));
    expect(failed[0]).toEqual({ status: "failed", audioId: null });

    const audio = await db()
      .select({ id: audioRecordings.id })
      .from(audioRecordings)
      .where(eq(audioRecordings.id, audioId));
    expect(audio).toHaveLength(0);

    const cleanup = await db()
      .select({
        reason: storageCleanupJobs.reason,
        nextAttemptAt: storageCleanupJobs.nextAttemptAt,
      })
      .from(storageCleanupJobs)
      .where(eq(storageCleanupJobs.storageKey, storageKey));
    expect(cleanup[0]?.reason).toBe("stale-attempt-audio");
    expect(cleanup[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  integration("replays an offline session key without duplicating sessions", async () => {
    const deviceId = `offline-${crypto.randomUUID()}`;
    const learnerResponse = await app.inject({
      method: "POST",
      url: "/api/learners/anonymous",
      payload: { deviceId, lang: "en" },
    });
    const { token } = learnerResponse.json();
    const prompt = (await app.inject({ method: "GET", url: "/api/prompts?lang=en" })).json()
      .prompts[0];
    const clientSessionId = `offline-session-${crypto.randomUUID()}`;

    const create = () =>
      app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: `Bearer ${token}` },
        payload: { promptId: prompt.id, clientSessionId },
      });

    const firstCreate = await create();
    const replayCreate = await create();
    expect(firstCreate.statusCode).toBe(200);
    expect(replayCreate.statusCode).toBe(200);
    expect(replayCreate.json().session.id).toBe(firstCreate.json().session.id);

    // The same key must never be reused across prompts.
    const otherPrompt = (await app.inject({ method: "GET", url: "/api/prompts?lang=en" })).json()
      .prompts[1];
    const conflict = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { promptId: otherPrompt.id, clientSessionId },
    });
    expect(conflict.statusCode).toBe(409);
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

describe("Daily Story sync repository", () => {
  const prefix = `integration-sync-${crypto.randomUUID()}-`;
  const contentHash = "a".repeat(64);

  function liveObject(conversationId: string, revision: number, text: string) {
    return {
      conversationId,
      schemaVersion: 1 as const,
      revision,
      sessionInstanceId: `session-${conversationId}`,
      updatedAt: new Date().toISOString(),
      phase: "chatting" as const,
      storyZh: "故事",
      messages: [{ id: "assistant_1", role: "assistant" as const, text }],
    };
  }

  function mutation(
    mutationId: string,
    expectedRemoteRevision: number | null,
    object: ReturnType<typeof liveObject> | null,
  ): DailyStorySyncPushRequest {
    return {
      mutationId,
      expectedRemoteRevision,
      clientRevision: object?.revision ?? 0,
      ...(object?.sessionInstanceId ? { sessionInstanceId: object.sessionInstanceId } : {}),
      object,
    };
  }

  async function apply(
    conversationId: string,
    input: DailyStorySyncPushRequest,
    mutationHash: string,
  ) {
    return dailyStorySyncRepository.apply(conversationId, input, contentHash, mutationHash);
  }

  integration("enforces idempotent mutation hashes, CAS, tombstones, and concurrency", async () => {
    const conversationId = `${prefix}semantics`;
    const first = mutation("mutation-first", null, liveObject(conversationId, 1, "Hello."));
    const accepted = await apply(conversationId, first, "mutation-hash-first");
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("initial sync mutation was rejected");
    expect(await apply(conversationId, first, "mutation-hash-first")).toMatchObject({
      kind: "accepted",
      idempotent: true,
    });
    expect((await apply(conversationId, first, "different-mutation-hash")).kind).toBe(
      "invalid_mutation",
    );

    const stale = mutation("mutation-stale", null, liveObject(conversationId, 2, "Stale."));
    expect((await apply(conversationId, stale, "mutation-hash-stale")).kind).toBe("conflict");

    const second = mutation(
      "mutation-second",
      accepted.row.remoteRevision,
      liveObject(conversationId, 2, "Updated."),
    );
    const updated = await apply(conversationId, second, "mutation-hash-second");
    expect(updated.kind).toBe("accepted");
    if (updated.kind !== "accepted") throw new Error("CAS update was rejected");

    const deleted = mutation("mutation-delete", updated.row.remoteRevision, null);
    const tombstone = await apply(conversationId, deleted, "mutation-hash-delete");
    expect(tombstone).toMatchObject({ kind: "accepted", idempotent: false });
    expect(
      (
        await apply(
          conversationId,
          mutation("mutation-resurrect", null, liveObject(conversationId, 3, "Old.")),
          "mutation-hash-resurrect",
        )
      ).kind,
    ).toBe("conflict");

    const concurrentId = `${prefix}concurrent`;
    const [left, right] = await Promise.all([
      apply(
        concurrentId,
        mutation("mutation-left", null, liveObject(concurrentId, 1, "Left.")),
        "mutation-hash-left",
      ),
      apply(
        concurrentId,
        mutation("mutation-right", null, liveObject(concurrentId, 1, "Right.")),
        "mutation-hash-right",
      ),
    ]);
    expect([left.kind, right.kind].sort()).toEqual(["accepted", "conflict"]);
  });

  integration("paginates more than one hundred tombstone/live objects", async () => {
    await db()
      .delete(dailyStorySyncObjects)
      .where(like(dailyStorySyncObjects.conversationId, `${prefix}%`));
    for (let index = 0; index < 101; index += 1) {
      const conversationId = `${prefix}page-${String(index).padStart(3, "0")}`;
      const result = await apply(
        conversationId,
        mutation(`mutation-page-${index}`, null, liveObject(conversationId, 1, `Page ${index}.`)),
        `mutation-hash-page-${index}`,
      );
      expect(result.kind).toBe("accepted");
    }

    const first = await dailyStorySyncRepository.list(100);
    expect(first).toHaveLength(100);
    const last = first.at(-1);
    if (!last) throw new Error("first sync page is empty");
    const second = await dailyStorySyncRepository.list(100, {
      updatedAt: last.updatedAt.toISOString(),
      conversationId: last.conversationId,
    });
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect(
      new Set([...first, ...second].map((row) => row.conversationId)).size,
    ).toBeGreaterThanOrEqual(101);

    const encoded = encodeSyncCursor(last);
    expect(encoded).toBeTruthy();
    await db()
      .delete(dailyStorySyncObjects)
      .where(like(dailyStorySyncObjects.conversationId, `${prefix}%`));
  });
});
