import { identifyProviderPreset, type DailyStoryAsrConfig } from "@kotoba/contracts";
import type { Env } from "../env";
import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import type { ProviderProbe } from "../platform/ai/probe";
import { DailyProviderRequestError, createDailySafeHttpsClient } from "./safe-https-client";

const JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Detect the Beijing DashScope OpenAI-compatible ASR endpoint. */
export function isDashScopeCompatibleAsrUrl(value: string) {
  return identifyProviderPreset(value) === "dashscope-compatible";
}

/** Pure ASR transport for DashScope's chat-completions-compatible interface. */
export function createDashScopeCompatibleSpeechToText(
  config: Env,
  provider: DailyStoryAsrConfig,
): SpeechToText & ProviderProbe {
  const allowSyntheticDns =
    config.NODE_ENV !== "production" && config.DAILY_PROVIDER_ALLOW_SYNTHETIC_DNS;
  const client = createDailySafeHttpsClient(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      timeoutMs: 30_000,
      // Audio requests are not replayed automatically. The caller can retry
      // deliberately without multiplying provider load.
      maxAttempts: 1,
      maxResponseBytes: JSON_RESPONSE_BYTES,
      production: config.NODE_ENV === "production",
      allowSyntheticDns,
      allowedOrigins: config.DAILY_PROVIDER_ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
    {
      ...(config.NODE_ENV === "test" && allowSyntheticDns ? { fetch: globalThis.fetch } : {}),
    },
  );

  const probe = async (requestId?: string) => {
    await requestDashScopeAsr(client, provider, silentWav(), "audio/wav", "en", requestId);
  };
  return {
    name: "dashscope-compatible-asr",
    probe,
    check: probe,
    async transcribe(input) {
      const response = await requestDashScopeAsr(
        client,
        provider,
        input.audio,
        cleanAudioMime(input.mimeType),
        input.locale?.split("-", 1)[0] ?? "en",
        input.requestId,
      );
      return parseDashScopeTranscript(response);
    },
  };
}

export function createDashScopeAsrBody(
  model: string,
  audio: Uint8Array,
  mimeType: string,
  language = "en",
) {
  const data = `data:${cleanAudioMime(mimeType)};base64,${Buffer.from(audio).toString("base64")}`;
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data },
          },
        ],
      },
    ],
    stream: false,
    asr_options: {
      language,
      enable_itn: false,
    },
  };
}

export function parseDashScopeTranscript(value: unknown): Transcript {
  const record = asRecord(value);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  const text = contentText(message?.content);
  if (!text) throw new DailyProviderRequestError("response");
  return { text, provider: "dashscope-compatible-asr" };
}

async function requestDashScopeAsr(
  client: ReturnType<typeof createDailySafeHttpsClient>,
  provider: DailyStoryAsrConfig,
  audio: Uint8Array,
  mimeType: string,
  language: string,
  requestId?: string,
) {
  const response = await client.request({
    path: "/chat/completions",
    body: new TextEncoder().encode(
      JSON.stringify(createDashScopeAsrBody(provider.model, audio, mimeType, language)),
    ),
    headers: { "content-type": "application/json" },
    requestId,
    maxResponseBytes: JSON_RESPONSE_BYTES,
  });
  try {
    return JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
  } catch {
    throw new DailyProviderRequestError("response");
  }
}

function contentText(value: unknown): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .flatMap((item) => {
              if (typeof item === "string") return [item];
              const record = asRecord(item);
              return typeof record?.text === "string" ? [record.text] : [];
            })
            .join("")
        : undefined;
  return text?.trim() ? text : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function cleanAudioMime(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
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
