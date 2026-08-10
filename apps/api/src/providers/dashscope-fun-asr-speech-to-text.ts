import { isDashScopeBaseUrl, type DailyStoryAsrConfig } from "@kotoba/contracts";
import type { Env } from "../env";
import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import { DailyProviderRequestError, createDailySafeHttpsClient } from "./safe-https-client";

const JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const FUN_ASR_MODEL = /^fun-asr-realtime(?:-\d{4}-\d{2}-\d{2})?$/;

/** Detect native DashScope HTTP ASR models configured on a DashScope endpoint. */
export function isDashScopeFunAsrProvider(
  provider: Pick<DailyStoryAsrConfig, "baseUrl" | "model">,
) {
  return isDashScopeBaseUrl(provider.baseUrl) && FUN_ASR_MODEL.test(provider.model);
}

/** Native HTTP adapter for Fun-ASR-Realtime's recorded-audio API. */
export function createDashScopeFunAsrSpeechToText(
  config: Env,
  provider: DailyStoryAsrConfig,
): SpeechToText {
  const client = createDailySafeHttpsClient({
    // Fun-ASR-Realtime uses the native `/api/v1` endpoint even when the user
    // entered the familiar `/compatible-mode/v1` DashScope endpoint.
    baseUrl: new URL("/api/v1", new URL(provider.baseUrl).origin).toString(),
    apiKey: provider.apiKey,
    timeoutMs: 30_000,
    maxAttempts: 1,
    maxResponseBytes: JSON_RESPONSE_BYTES,
    production: config.NODE_ENV === "production",
    allowSyntheticDns:
      config.NODE_ENV !== "production" && config.DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS,
    allowedOrigins: config.DAILY_PROVIDER_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });

  return {
    name: "dashscope-fun-asr",
    async check(requestId?: string) {
      await requestFunAsr(client, provider, silentWav(), "audio/wav", requestId);
    },
    async transcribe(input) {
      const response = await requestFunAsr(
        client,
        provider,
        input.audio,
        input.mimeType,
        input.requestId,
      );
      return parseDashScopeFunAsrTranscript(response);
    },
  };
}

export function createDashScopeFunAsrBody(model: string, audio: Uint8Array, mimeType: string) {
  const cleanMimeType = cleanAudioMime(mimeType);
  return {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              audio: `data:${cleanMimeType};base64,${Buffer.from(audio).toString("base64")}`,
            },
          ],
        },
      ],
    },
    parameters: { format: audioFormat(cleanMimeType) },
    resources: [],
  };
}

export function parseDashScopeFunAsrTranscript(value: unknown): Transcript {
  const record = asRecord(value);
  const output = asRecord(record?.output);
  const sentence = asRecord(output?.sentence);
  const text = typeof output?.text === "string" ? output.text : sentence?.text;
  if (typeof text !== "string") throw new DailyProviderRequestError("response");
  return { text, provider: "dashscope-fun-asr" };
}

async function requestFunAsr(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryAsrConfig,
  audio: Uint8Array,
  mimeType: string,
  requestId?: string,
) {
  const response = await client.request({
    path: "/services/aigc/multimodal-generation/generation",
    body: new TextEncoder().encode(
      JSON.stringify(createDashScopeFunAsrBody(provider.model, audio, mimeType)),
    ),
    headers: {
      "content-type": "application/json",
      "x-dashscope-sse": "disable",
    },
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

function cleanAudioMime(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "audio/wav";
}

function audioFormat(mimeType: string) {
  return (
    {
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/webm": "webm",
      "audio/mp4": "mp4",
      "audio/aac": "aac",
      "audio/opus": "opus",
    }[mimeType] ??
    mimeType.split("/", 2)[1] ??
    "wav"
  );
}

function silentWav() {
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
