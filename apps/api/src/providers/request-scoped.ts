import { randomUUID } from "node:crypto";
import type {
  DailyStoryAsrConfig,
  DailyStoryChatConfig,
  DailyStoryTtsConfig,
} from "@kotoba/contracts";
import type { Env } from "../env";
import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import type { TextModel, TextModelRequest, TextModelResponse } from "../capabilities/text-model";
import type { TextToSpeech, SynthesizedAudio } from "../capabilities/text-to-speech";
import { DailyProviderRequestError, createDailySafeHttpsClient } from "./safe-https-client";

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
    ...(input.chat ? { chat: createDailyStoryTextModel(config, input.chat) } : {}),
    ...(input.asr ? { asr: createDailyStorySpeechToText(config, input.asr) } : {}),
    ...(input.tts ? { tts: createDailyStoryTextToSpeech(config, input.tts) } : {}),
  };
}

export function createDailyStoryTextModel(config: Env, provider: DailyStoryChatConfig): TextModel {
  const client = transport(config, provider);
  return {
    name: "daily-story-request-scoped-chat",
    async check() {
      await requestChat(client, provider, [{ role: "user", content: "Reply with OK." }], 1);
    },
    async generate(input: TextModelRequest): Promise<TextModelResponse> {
      const data = await requestChat(client, provider, input.messages, input.maxTokens, input);
      const source = asRecord(data);
      const first = Array.isArray(source?.choices) ? asRecord(source.choices[0]) : undefined;
      const message = asRecord(first?.message);
      const content = contentFrom(message?.content);
      if (!content) throw new DailyProviderRequestError("response");
      const usage = asRecord(source?.usage);
      return {
        content,
        provider: "daily-story-openai-compatible",
        model: provider.model,
        ...(usage
          ? {
              usage: {
                ...(typeof usage.prompt_tokens === "number"
                  ? { inputTokens: usage.prompt_tokens }
                  : {}),
                ...(typeof usage.completion_tokens === "number"
                  ? { outputTokens: usage.completion_tokens }
                  : {}),
              },
            }
          : {}),
      };
    },
  };
}

export function createDailyStorySpeechToText(
  config: Env,
  provider: DailyStoryAsrConfig,
): SpeechToText {
  const client = transport(config, provider);
  return {
    name: "daily-story-request-scoped-asr",
    async check() {
      await sendTranscription(client, provider, silentWav(), "audio/wav", "probe.wav", undefined);
    },
    async transcribe(input): Promise<Transcript> {
      return sendTranscription(
        client,
        provider,
        input.audio,
        input.mimeType,
        filenameForMime(input.mimeType),
        input.requestId,
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

function transport(config: Env, provider: Pick<DailyStoryChatConfig, "baseUrl" | "apiKey">) {
  return createDailySafeHttpsClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    timeoutMs: 30_000,
    maxAttempts: config.HTTP_MAX_ATTEMPTS,
    maxResponseBytes: JSON_RESPONSE_BYTES,
    production: config.NODE_ENV === "production",
    allowedOrigins: config.DAILY_PROVIDER_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
}

async function requestChat(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryChatConfig,
  messages: TextModelRequest["messages"],
  maxTokens?: number,
  input?: TextModelRequest,
) {
  return requestJson(
    client,
    "/chat/completions",
    {
      model: provider.model,
      messages,
      ...(input?.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(input?.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    },
    input?.requestId,
  );
}

async function sendTranscription(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryAsrConfig,
  audio: Uint8Array,
  mimeType: string,
  filename: string,
  requestId: string | undefined,
): Promise<Transcript> {
  const boundary = `----daily-story-${randomUUID()}`;
  const body = multipartBody(boundary, [
    { name: "model", value: provider.model },
    { name: "response_format", value: provider.responseFormat ?? "verbose_json" },
    { name: "language", value: "en" },
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

function contentFrom(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string"
        ? record.text
        : typeof record?.content === "string"
          ? record.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
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
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  return new Uint8Array(header);
}
