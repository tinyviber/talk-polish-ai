import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROMPTS, fixtureFeedback } from "@kotoba/contracts";
import { createOpenAICompatibleAssessmentProvider } from "./openai-assessment";
import { createOpenAICompatibleHttpClient } from "./http";
import { createLocalAudioStorage } from "./local-storage";
import { createOpenAICompatibleSpeechToText } from "./openai-speech-to-text";
import { createOpenAICompatibleTranscriptionProvider } from "./openai-transcription";
import { createOpenAICompatibleTtsProvider } from "./openai-tts";
import { createOpenAICompatibleTextModel } from "./openai-text-model";
import { createRealtimeProvider } from "./realtime";
import { DailyProviderRequestError } from "./safe-https-client";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let chatRequests = 0;
let chatBodies: Array<Record<string, unknown>> = [];
let transcriptionMultipartBodies: Array<Record<string, string>> = [];
let alwaysInvalidFeedback = false;
let tempDir = "";
let realtimeServer: ReturnType<typeof Bun.serve>;
let realtimeUrl = "";

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kotoba-openai-fixture-"));
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== "Bearer fixture-key") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/retry") {
        chatRequests += 1;
        return chatRequests === 1
          ? new Response("retry", { status: 503 })
          : Response.json({ ok: true });
      }
      if (url.pathname === "/chat/completions") {
        chatRequests += 1;
        chatBodies.push((await request.json()) as Record<string, unknown>);
        const feedback = JSON.stringify(fixtureFeedback("en-smalltalk", "en", 1));
        const content = alwaysInvalidFeedback || chatRequests === 1 ? "{invalid" : feedback;
        return Response.json({ choices: [{ message: { content } }] });
      }
      if (url.pathname === "/audio/transcriptions") {
        const form = await request.formData();
        const fields: Record<string, string> = {};
        for (const [key, value] of form.entries()) {
          if (typeof value === "string") fields[key] = value;
        }
        transcriptionMultipartBodies.push(fields);
        return Response.json({
          text: "real transcript",
          segments: [{ id: 0, start: 0, end: 1, text: "real transcript", confidence: 0.8 }],
          words: [{ word: "real", start: 0, end: 0.4, confidence: 0.9 }],
          confidence: 0.8,
        });
      }
      if (url.pathname === "/audio/speech") {
        return new Response(Buffer.from("fixture audio"), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  baseUrl = server.url.origin;
  realtimeServer = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (
        request.headers.get("authorization") !== "Bearer fixture-key" ||
        request.headers.get("openai-beta") !== "realtime=v1" ||
        !request.headers.get("x-request-id")
      ) {
        return new Response("missing realtime headers", { status: 401 });
      }
      if (server.upgrade(request, { data: {} })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "session.created" }));
      },
      message(socket, message) {
        const parsed = JSON.parse(String(message)) as { type?: string };
        if (parsed.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        }
      },
    },
  });
  realtimeUrl = realtimeServer.url.href.replace(/^http/i, "ws");
});

afterAll(async () => {
  server.stop(true);
  realtimeServer.stop(true);
  await rm(tempDir, { recursive: true, force: true });
});

describe("OpenAI-compatible HTTP fixtures", () => {
  test("retries transient HTTP failure and preserves request auth boundary", async () => {
    chatRequests = 0;
    const client = createOpenAICompatibleHttpClient({
      capability: "fixture",
      baseUrl,
      apiKey: "fixture-key",
      timeoutMs: 2_000,
      maxAttempts: 3,
    });
    const response = await client.requestJson<{ ok: boolean }>({
      operation: "fixture.retry",
      path: "/retry",
      body: {},
    });
    expect(response.ok).toBe(true);
    expect(chatRequests).toBe(2);
  });

  test("assesses strict feedback after one controlled JSON repair", async () => {
    chatRequests = 0;
    chatBodies = [];
    const provider = createOpenAICompatibleAssessmentProvider({
      baseUrl,
      apiKey: "fixture-key",
      model: "fixture-chat",
      timeoutMs: 2_000,
      maxAttempts: 2,
    });
    const result = await provider.assess({
      transcript: "I went to the park.",
      prompt: PROMPTS[0]!,
      lang: "en",
      attemptIndex: 1,
      durationSec: 8,
    });
    expect(result.feedback.overall).toBeGreaterThan(0);
    expect(chatRequests).toBe(2);
    expect(chatBodies[0]).toMatchObject({
      model: "fixture-chat",
      response_format: { type: "json_object" },
    });
    expect(chatBodies[0]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    );
  });

  test("fails when the controlled JSON repair is still invalid", async () => {
    alwaysInvalidFeedback = true;
    chatRequests = 0;
    chatBodies = [];
    const provider = createOpenAICompatibleAssessmentProvider({
      baseUrl,
      apiKey: "fixture-key",
      model: "fixture-chat",
      timeoutMs: 2_000,
      maxAttempts: 1,
    });
    await expect(
      provider.assess({
        transcript: "I went to the park.",
        prompt: PROMPTS[0]!,
        lang: "en",
        attemptIndex: 1,
        durationSec: 8,
      }),
    ).rejects.toMatchObject({ code: "response" });
    alwaysInvalidFeedback = false;
  });

  test("preserves an upstream status wrapped by the AI SDK fetch layer", async () => {
    const model = createOpenAICompatibleTextModel(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        model: "fixture-chat",
        timeoutMs: 2_000,
        maxAttempts: 1,
      },
      {
        fetch: async () => {
          throw new DailyProviderRequestError("http", 401);
        },
      },
    );

    await expect(
      model.generate({ messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toMatchObject({
      code: "http",
      status: 401,
    });
  });

  test("reads ASR bytes through storage and preserves returned metadata", async () => {
    const storage = createLocalAudioStorage(tempDir);
    const stored = await storage.put({
      key: "recordings/fixture.wav",
      body: Buffer.from("wav"),
      contentType: "audio/wav",
    });
    const provider = createOpenAICompatibleTranscriptionProvider(
      {
        baseUrl,
        apiKey: "fixture-key",
        model: "fixture-transcribe",
        timeoutMs: 2_000,
        maxAttempts: 2,
      },
      storage,
    );
    transcriptionMultipartBodies = [];
    const result = await provider.transcribe({
      lang: "en",
      promptId: PROMPTS[0]!.id,
      attemptIndex: 1,
      durationSec: 1,
      audio: { storageKey: stored.storageKey, mimeType: "audio/wav", bytes: 3 },
    });
    await provider.transcribe({
      lang: "ja",
      promptId: PROMPTS[0]!.id,
      attemptIndex: 1,
      durationSec: 1,
      audio: { storageKey: stored.storageKey, mimeType: "audio/wav", bytes: 3 },
    });
    expect(result.text).toBe("real transcript");
    expect(result.transcription?.confidence).toBe(0.8);
    expect(result.transcription?.wordTimestamps?.[0]?.word).toBe("real");
    expect(transcriptionMultipartBodies).toEqual([
      { model: "fixture-transcribe", language: "en", response_format: "json" },
      { model: "fixture-transcribe", language: "ja", response_format: "json" },
    ]);
    expect(transcriptionMultipartBodies.every((body) => !("prompt" in body))).toBe(true);
  });

  test("sends locale without an English-only prompt", async () => {
    transcriptionMultipartBodies = [];
    const provider = createOpenAICompatibleSpeechToText({
      baseUrl,
      apiKey: "fixture-key",
      model: "fixture-speech-to-text",
      timeoutMs: 2_000,
      maxAttempts: 2,
    });
    await provider.transcribe({
      audio: Buffer.from("wav"),
      mimeType: "audio/wav",
      locale: "en-US",
      requestId: "fixture-en",
    });
    await provider.transcribe({
      audio: Buffer.from("wav"),
      mimeType: "audio/wav",
      locale: "ja-JP",
      requestId: "fixture-ja",
    });
    expect(transcriptionMultipartBodies).toEqual([
      { model: "fixture-speech-to-text", language: "en", response_format: "json" },
      { model: "fixture-speech-to-text", language: "ja", response_format: "json" },
    ]);
    expect(transcriptionMultipartBodies.every((body) => !("prompt" in body))).toBe(true);
  });

  test("caches TTS bytes in storage and returns stable object reference", async () => {
    const storage = createLocalAudioStorage(tempDir);
    const provider = createOpenAICompatibleTtsProvider(
      {
        baseUrl,
        apiKey: "fixture-key",
        model: "fixture-tts",
        voice: "alloy",
        timeoutMs: 2_000,
        maxAttempts: 2,
      },
      storage,
    );
    const first = await provider.synthesize({ text: "Hello", lang: "en" });
    const second = await provider.synthesize({ text: "Hello", lang: "en" });
    expect(first.storageKey).toBe(second.storageKey);
    expect(await storage.get(first.storageKey!)).toEqual(Buffer.from("fixture audio"));
  });

  test("smokes the independent Realtime session protocol fixture", async () => {
    const provider = createRealtimeProvider({
      enabled: true,
      url: realtimeUrl,
      apiKey: "fixture-key",
      model: "fixture-realtime",
      protocol: "websocket",
      timeoutMs: 2_000,
    });
    await provider.smokeTest();
  });
});
