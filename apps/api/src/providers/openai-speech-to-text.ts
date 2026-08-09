import type { SpeechToText, Transcript } from "../capabilities/speech-to-text";
import { createOpenAICompatibleHttpClient, ProviderConfigurationError } from "./http";

export type OpenAISpeechToTextConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  responseFormat?: "json" | "verbose_json";
  timeoutMs: number;
  maxAttempts: number;
};

/** Pure ASR transport. Storage and product workflow live in the caller. */
export function createOpenAICompatibleSpeechToText(config: OpenAISpeechToTextConfig): SpeechToText {
  const client = createOpenAICompatibleHttpClient({ capability: "transcription", ...config });
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
      const mimeType = input.mimeType.split(";")[0]!.trim().toLowerCase();
      const result = await client.requestMultipart<unknown>({
        operation: "audio.transcriptions",
        path: "/audio/transcriptions",
        requestId: input.requestId,
        form: () => {
          const form = new FormData();
          form.append(
            "file",
            new Blob([input.audio], { type: mimeType }),
            extensionForMime(mimeType),
          );
          form.set("model", config.model!);
          if (input.locale) form.set("language", input.locale.split("-")[0]!);
          form.set(
            "prompt",
            "The speaker is practicing English. Transcribe the spoken English exactly. Do not translate, paraphrase, or invent text.",
          );
          form.set("response_format", config.responseFormat ?? "json");
          return form;
        },
      });
      return parseTranscript(result);
    },
  };
}

function requireConfigured(config: OpenAISpeechToTextConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("Transcription provider configuration is incomplete");
  }
}

function parseTranscript(value: unknown): Transcript {
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
    throw new Error("Transcription response did not contain text");
  }
  const source = value as Record<string, unknown>;
  const segments = Array.isArray(source.segments)
    ? source.segments.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const part = item as Record<string, unknown>;
        return [
          {
            ...(typeof part.id === "number" ? { id: part.id } : {}),
            ...(typeof part.start === "number" ? { start: part.start } : {}),
            ...(typeof part.end === "number" ? { end: part.end } : {}),
            ...(typeof part.text === "string" ? { text: part.text } : {}),
            ...(typeof part.confidence === "number" ? { confidence: part.confidence } : {}),
          },
        ];
      })
    : undefined;
  const words = Array.isArray(source.words)
    ? source.words.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const part = item as Record<string, unknown>;
        if (typeof part.word !== "string") return [];
        return [
          {
            word: part.word,
            ...(typeof part.start === "number" ? { start: part.start } : {}),
            ...(typeof part.end === "number" ? { end: part.end } : {}),
            ...(typeof part.confidence === "number" ? { confidence: part.confidence } : {}),
          },
        ];
      })
    : undefined;
  return {
    text: value.text,
    ...(segments?.length ? { segments } : {}),
    ...(words?.length ? { words } : {}),
    ...(typeof source.confidence === "number" ? { confidence: source.confidence } : {}),
    provider: "openai-compatible-transcription",
  };
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
  return header;
}
