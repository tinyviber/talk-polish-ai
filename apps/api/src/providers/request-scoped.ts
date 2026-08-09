import { randomUUID } from "node:crypto";
import type {
  DailyStoryAsrConfig,
  DailyStoryChatConfig,
  DailyStoryTtsConfig,
} from "@kotoba/contracts";
import type { Env } from "../env";
import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import type { TextModel } from "../capabilities/text-model";
import type { TextToSpeech, SynthesizedAudio } from "../capabilities/text-to-speech";
import { DailyProviderRequestError, createDailySafeHttpsClient } from "./safe-https-client";
import {
  createDashScopeCompatibleSpeechToText,
  isDashScopeCompatibleAsrUrl,
} from "./dashscope-compatible-speech-to-text";
import { createOpenAICompatibleTextModel } from "./openai-text-model";

const JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const AUDIO_RESPONSE_BYTES = 15 * 1024 * 1024;

export type DailyStoryRequestProviders = {
  chat: TextModel;
  asr: SpeechToText;
  tts: TextToSpeech;
};

/** Construct providers per request. Configurations and keys never reach a process cache. */
export function createDailyStoryRequestProviders(
  config: Env,
  input: Partial<{
    chat: DailyStoryChatConfig;
    asr: DailyStoryAsrConfig;
    tts: DailyStoryTtsConfig;
  }>,
): Partial<DailyStoryRequestProviders> {
  return {
    ...(input.chat
      ? { chat: createDailyStoryTextModel(config, normalizeProvider(input.chat)) }
      : {}),
    ...(input.asr
      ? { asr: createDailyStorySpeechToText(config, normalizeProvider(input.asr)) }
      : {}),
    ...(input.tts
      ? { tts: createDailyStoryTextToSpeech(config, normalizeProvider(input.tts)) }
      : {}),
  };
}

/** Accept both `https://host` and the OpenAI-compatible `https://host/v1` form. */
function normalizeProvider<T extends { baseUrl: string }>(provider: T): T {
  try {
    const url = new URL(provider.baseUrl);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1/";
    return { ...provider, baseUrl: url.toString().replace(/\/$/, "") };
  } catch {
    // URL validation remains the provider boundary's responsibility.
    return provider;
  }
}

export function createDailyStoryTextModel(config: Env, provider: DailyStoryChatConfig): TextModel {
  const model = createOpenAICompatibleTextModel(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      timeoutMs: 30_000,
      // Retry policy lives in the pinned transport below; avoid multiplying
      // attempts with AI SDK's own retry loop.
      maxAttempts: 1,
    },
    {
      name: "daily-story-request-scoped-chat",
      fetch: createDailyProviderFetch(config, provider),
    },
  );
  return {
    ...model,
    name: "daily-story-request-scoped-chat",
    async check() {
      await model.generate({
        messages: [{ role: "user", content: "Reply with OK." }],
        // Some reasoning-compatible gateways reject max_tokens=1 before
        // producing even a short probe response.
        maxTokens: 32,
      });
    },
  };
}

function createDailyProviderFetch(
  config: Env,
  provider: Pick<DailyStoryChatConfig, "baseUrl" | "apiKey">,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const client = transport(config, provider);
  const base = new URL(provider.baseUrl.endsWith("/") ? provider.baseUrl : `${provider.baseUrl}/`);

  return async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const requested = new URL(request.url);
    if (requested.origin !== base.origin || !requested.pathname.startsWith(base.pathname)) {
      throw new DailyProviderRequestError("redirect");
    }
    const relativePath = `${requested.pathname.slice(base.pathname.length - 1)}${requested.search}`;
    const headers = new Headers(request.headers);
    let response;
    try {
      response = await client.request({
        path: relativePath,
        body: new Uint8Array(await request.arrayBuffer()),
        headers: selectProviderHeaders(headers),
        requestId: headers.get("x-request-id") ?? undefined,
        maxResponseBytes: JSON_RESPONSE_BYTES,
      });
    } catch (error) {
      // Let the AI SDK observe HTTP status codes so auth/rate-limit errors do
      // not become indistinguishable from network failures. The safe client
      // already discarded the upstream body, so this response cannot leak it.
      if (
        error instanceof DailyProviderRequestError &&
        error.code === "http" &&
        error.status !== undefined
      ) {
        if (config.NODE_ENV !== "production" && error.reason) {
          console.warn("[daily-story upstream response]", {
            status: error.status,
            reason: error.reason,
          });
        }
        return new Response(null, { status: error.status });
      }
      throw error;
    }
    return new Response(response.bytes, {
      status: response.status,
      headers: { "content-type": response.contentType ?? "application/json" },
    });
  };
}

function selectProviderHeaders(headers: Headers) {
  const selected: Record<string, string> = {};
  for (const name of ["accept", "content-type"]) {
    const value = headers.get(name);
    if (value) selected[name] = value;
  }
  return selected;
}

export function createDailyStorySpeechToText(
  config: Env,
  provider: DailyStoryAsrConfig,
): SpeechToText {
  if (isDashScopeCompatibleAsrUrl(provider.baseUrl)) {
    return createDashScopeCompatibleSpeechToText(config, provider);
  }
  return createOpenAICompatibleDailyStorySpeechToText(config, provider);
}

function createOpenAICompatibleDailyStorySpeechToText(
  config: Env,
  provider: DailyStoryAsrConfig,
): SpeechToText {
  // A transcription upload is large and usually not idempotent at the
  // gateway. Retrying the same audio three times only multiplies provider
  // load and makes the browser timeout before the API can return a useful
  // 503. The cached recording remains available for an explicit retry.
  const client = transport(config, provider, { maxAttempts: 1 });
  return {
    name: "daily-story-request-scoped-asr",
    async check() {
      await sendTranscription(
        client,
        provider,
        silentWav(),
        "audio/wav",
        "probe.wav",
        undefined,
        config.NODE_ENV !== "production",
      );
    },
    async transcribe(input): Promise<Transcript> {
      return sendTranscription(
        client,
        provider,
        input.audio,
        input.mimeType,
        filenameForMime(input.mimeType),
        input.requestId,
        config.NODE_ENV !== "production",
      );
    },
  };
}

export function createDailyStoryTextToSpeech(
  config: Env,
  provider: DailyStoryTtsConfig,
): TextToSpeech {
  const client = transport(config, provider);
  return {
    name: "daily-story-request-scoped-tts",
    async check() {
      await synthesize(client, provider, "ping", undefined);
    },
    async synthesize(input): Promise<SynthesizedAudio> {
      const result = await synthesize(client, provider, input.text, input.requestId, input.voice);
      return {
        bytes: result.bytes,
        contentType: result.contentType,
        provider: "daily-story-openai-compatible",
      };
    },
  };
}

function transport(
  config: Env,
  provider: Pick<DailyStoryChatConfig, "baseUrl" | "apiKey">,
  options: { maxAttempts?: number } = {},
) {
  return createDailySafeHttpsClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    timeoutMs: 30_000,
    maxAttempts: options.maxAttempts ?? config.HTTP_MAX_ATTEMPTS,
    maxResponseBytes: JSON_RESPONSE_BYTES,
    production: config.NODE_ENV === "production",
    allowSyntheticDns:
      config.NODE_ENV !== "production" && config.DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS,
    allowedOrigins: config.DAILY_PROVIDER_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
}

async function sendTranscription(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryAsrConfig,
  audio: Uint8Array,
  mimeType: string,
  filename: string,
  requestId: string | undefined,
  diagnostics = false,
): Promise<Transcript> {
  const englishTranscriptionPrompt =
    "The speaker is practicing English. Transcribe the spoken English exactly. Do not translate, paraphrase, or invent text.";
  const boundary = `----daily-story-${randomUUID()}`;
  const body = multipartBody(boundary, [
    { name: "model", value: provider.model },
    { name: "response_format", value: provider.responseFormat ?? "json" },
    { name: "language", value: "en" },
    { name: "prompt", value: englishTranscriptionPrompt },
    { name: "file", filename, contentType: cleanAudioMime(mimeType), value: audio },
  ]);
  const value = await requestJsonBytes(
    client,
    "/audio/transcriptions",
    body,
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    requestId,
  );
  const source = asRecord(value);
  if (diagnostics) {
    console.info("[daily-story asr result]", {
      baseUrl: provider.baseUrl,
      model: provider.model,
      format: provider.responseFormat ?? "json",
      mimeType: cleanAudioMime(mimeType),
      filename,
      audioBytes: audio.byteLength,
      textLength: typeof source?.text === "string" ? source.text.length : null,
      detectedLanguage: typeof source?.language === "string" ? source.language : null,
      segmentCount: Array.isArray(source?.segments) ? source.segments.length : null,
    });
  }
  // Do not trim, normalize, spell-correct, or otherwise alter ASR text.
  if (typeof source?.text !== "string") throw new DailyProviderRequestError("response");
  return { text: source.text, provider: "daily-story-openai-compatible" };
}

async function synthesize(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryTtsConfig,
  text: string,
  requestId?: string,
  voice = provider.voice,
) {
  const body = new TextEncoder().encode(
    JSON.stringify({ model: provider.model, voice, input: text, response_format: "mp3" }),
  );
  const response = await client.request({
    path: "/audio/speech",
    body,
    headers: { "content-type": "application/json" },
    requestId,
    accept: "audio/*",
    maxResponseBytes: AUDIO_RESPONSE_BYTES,
  });
  const contentType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("audio/") || response.bytes.byteLength === 0) {
    throw new DailyProviderRequestError("response");
  }
  return { bytes: response.bytes, contentType };
}

async function requestJson(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  path: string,
  value: unknown,
  requestId?: string,
) {
  return requestJsonBytes(
    client,
    path,
    new TextEncoder().encode(JSON.stringify(value)),
    { "content-type": "application/json" },
    requestId,
  );
}

async function requestJsonBytes(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  path: string,
  body: Uint8Array,
  headers: Record<string, string>,
  requestId?: string,
) {
  const response = await client.request({
    path,
    body,
    headers,
    requestId,
    maxResponseBytes: JSON_RESPONSE_BYTES,
  });
  try {
    return JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
  } catch {
    throw new DailyProviderRequestError("response");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function multipartBody(
  boundary: string,
  fields: Array<{
    name: string;
    value: string | Uint8Array;
    filename?: string;
    contentType?: string;
  }>,
) {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (field.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n` +
            `Content-Type: ${field.contentType ?? "application/octet-stream"}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.from(field.value));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n`));
      chunks.push(Buffer.from(field.value));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

function cleanAudioMime(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function filenameForMime(mime: string) {
  return (
    (
      {
        "audio/webm": "recording.webm",
        "audio/ogg": "recording.ogg",
        "audio/wav": "recording.wav",
        "audio/x-wav": "recording.wav",
        "audio/mpeg": "recording.mp3",
        "audio/mp4": "recording.m4a",
        "audio/m4a": "recording.m4a",
      } as Record<string, string>
    )[cleanAudioMime(mime)] ?? "recording.audio"
  );
}

function silentWav() {
  // A one-second PCM sample: some gateways reject very short or empty WAVs.
  const sampleRate = 16_000;
  const dataBytes = sampleRate * 2;
  const header = Buffer.alloc(44 + dataBytes);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(header);
}
