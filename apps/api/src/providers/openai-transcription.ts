import type { Lang, TranscriptionMetadata } from "@kotoba/contracts";
import type { AudioStorageProvider } from "./storage";
import {
  createOpenAICompatibleHttpClient,
  ProviderConfigurationError,
  type OpenAICompatibleHttpClient,
} from "./http";
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "./transcription";

export type OpenAITranscriptionConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** `json` for servers that do not implement verbose transcription payloads. */
  responseFormat?: "json" | "verbose_json";
  timeoutMs: number;
  maxAttempts: number;
};

export function createOpenAICompatibleTranscriptionProvider(
  config: OpenAITranscriptionConfig,
  storage: AudioStorageProvider,
): TranscriptionProvider {
  const client = createOpenAICompatibleHttpClient({
    capability: "transcription",
    ...config,
  });
  return {
    name: "openai-compatible-transcription",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await client.requestMultipart({
        operation: "audio.transcriptions.probe",
        path: "/audio/transcriptions",
        form: () => {
          const form = new FormData();
          form.append("file", new Blob([silentWav()], { type: "audio/wav" }), "probe.wav");
          form.set("model", config.model!);
          form.set("response_format", "json");
          return form;
        },
      });
    },
    async transcribe(input) {
      requireConfigured(config);
      if (!input.audio) throw new ProviderConfigurationError("Real transcription requires audio");
      const body = await storage.get(input.audio.storageKey);
      if (!body) throw new Error("Stored recording is unavailable");
      const mimeType = input.audio.mimeType.split(";")[0]!.trim().toLowerCase();
      const result = await client.requestMultipart<unknown>({
        operation: "audio.transcriptions",
        path: "/audio/transcriptions",
        form: () => {
          const form = new FormData();
          form.append("file", new Blob([body], { type: mimeType }), extensionForMime(mimeType));
          form.set("model", config.model!);
          form.set("language", langCode(input.lang));
          form.set(
            "prompt",
            "The speaker is practicing English. Transcribe the spoken English exactly. Do not translate, paraphrase, or invent text.",
          );
          form.set("response_format", config.responseFormat ?? "json");
          return form;
        },
      });
      const parsed = parseTranscriptionResponse(result);
      return {
        text: parsed.text,
        transcription: parsed.metadata,
        mocked: false,
        provider: "openai-compatible-transcription",
      };
    },
  };
}

function requireConfigured(config: OpenAITranscriptionConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("Transcription provider configuration is incomplete");
  }
}

function parseTranscriptionResponse(value: unknown): {
  text: string;
  metadata?: TranscriptionMetadata;
} {
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
    throw new Error("Transcription response did not contain text");
  }
  const source = value as Record<string, unknown>;
  const metadata: TranscriptionMetadata = {};
  const faithfulTranscript = stringValue(source.faithfulTranscript, source.faithful_transcript);
  const normalizedTranscript = stringValue(
    source.normalizedTranscript,
    source.normalized_transcript,
  );
  if (faithfulTranscript) metadata.faithfulTranscript = faithfulTranscript;
  if (normalizedTranscript) metadata.normalizedTranscript = normalizedTranscript;
  if (typeof source.confidence === "number")
    metadata.confidence = clampConfidence(source.confidence);
  const segments = parseSegments(source.segments);
  const words = parseWords(source.words ?? source.word_timestamps);
  if (segments.length > 0) metadata.segments = segments;
  if (words.length > 0) metadata.wordTimestamps = words;
  return { text: value.text, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
}

function parseSegments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    return [
      {
        ...(typeof source.id === "number" ? { id: source.id } : {}),
        ...(typeof source.start === "number" ? { start: source.start } : {}),
        ...(typeof source.end === "number" ? { end: source.end } : {}),
        ...(typeof source.text === "string" ? { text: source.text } : {}),
        ...(typeof source.confidence === "number"
          ? { confidence: clampConfidence(source.confidence) }
          : {}),
      },
    ];
  });
}

function parseWords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    if (typeof source.word !== "string") return [];
    return [
      {
        word: source.word,
        ...(typeof source.start === "number" ? { start: source.start } : {}),
        ...(typeof source.end === "number" ? { end: source.end } : {}),
        ...(typeof source.confidence === "number"
          ? { confidence: clampConfidence(source.confidence) }
          : {}),
      },
    ];
  });
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function clampConfidence(value: number) {
  return Math.min(1, Math.max(0, value));
}

function langCode(lang: Lang) {
  return lang === "ja" ? "ja" : "en";
}

function extensionForMime(mime: string) {
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
    )[mime] ?? "recording.audio"
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
  header.writeUInt32LE(0, 40);
  return header;
}
