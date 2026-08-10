import { gunzipSync } from "node:zlib";
import { isDashScopeBaseUrl, type DailyStoryAsrConfig } from "@kotoba/contracts";
import type { Env } from "../env";
import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import { DailyProviderRequestError, createDailySafeHttpsClient } from "./safe-https-client";

const JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const FUN_ASR_MODELS = new Set(["fun-asr-realtime", "fun-asr-realtime-2026-02-28"]);
const FUN_ASR_PROBE_MP3_GZIP_BASE64 =
  "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";

/** Detect native DashScope HTTP ASR models configured on a DashScope endpoint. */
export function isDashScopeFunAsrProvider(
  provider: Pick<DailyStoryAsrConfig, "baseUrl" | "model">,
) {
  return isDashScopeBaseUrl(provider.baseUrl) && FUN_ASR_MODELS.has(provider.model);
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
      await requestFunAsr(
        client,
        provider,
        createDashScopeFunAsrProbeAudio(),
        "audio/mpeg",
        requestId,
      );
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

/** A tiny synthetic speech fixture keeps provider checks valid without user audio. */
export function createDashScopeFunAsrProbeAudio() {
  return new Uint8Array(gunzipSync(Buffer.from(FUN_ASR_PROBE_MP3_GZIP_BASE64, "base64")));
}
