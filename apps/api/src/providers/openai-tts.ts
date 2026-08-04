import { createHash } from "node:crypto";
import type { Lang } from "@kotoba/contracts";
import { createOpenAICompatibleHttpClient, ProviderConfigurationError } from "./http";
import type { AudioStorageProvider } from "./storage";
import {
  withSynthesisStorageDisposition,
  type SynthesisInput,
  type SynthesisResult,
  type TextToSpeechProvider,
} from "./tts";

export type OpenAITtsConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice: string;
  timeoutMs: number;
  maxAttempts: number;
};

export function createOpenAICompatibleTtsProvider(
  config: OpenAITtsConfig,
  storage: AudioStorageProvider,
): TextToSpeechProvider {
  const client = createOpenAICompatibleHttpClient({ capability: "tts", ...config });
  return {
    name: "openai-compatible-tts",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await requestAudio(client, config.model!, config.voice, "ping");
    },
    async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
      requireConfigured(config);
      const model = config.model!;
      const voice = input.voice ?? config.voice;
      const scope = input.scope ?? "public";
      const purpose = input.purpose ?? "expression";
      const hash = createHash("sha256")
        .update(JSON.stringify({ model, voice, lang: input.lang, purpose, text: input.text }))
        .digest("hex");
      const logicalKey =
        `tts/${scope}/${purpose}/${model}/${voice}/${input.lang}/${hash}.mp3`.replace(
          /[^a-zA-Z0-9._/-]/g,
          "_",
        );
      const cachedKey = storage.keyFor?.(logicalKey);
      if (cachedKey && (await storage.get(cachedKey))) {
        return withSynthesisStorageDisposition(
          {
            storageKey: cachedKey,
            cacheStatus: "cache-hit",
            contentType: "audio/mpeg",
            seconds: estimateSeconds(input.text),
            provider: "openai-compatible-tts",
          },
          "cache-hit",
        );
      }

      const bytes = await requestAudio(client, model, voice, input.text);
      const stored = await storage.put({
        key: logicalKey,
        body: Buffer.from(bytes),
        contentType: "audio/mpeg",
      });
      return withSynthesisStorageDisposition(
        {
          storageKey: stored.storageKey,
          cacheStatus: "created",
          contentType: "audio/mpeg",
          seconds: estimateSeconds(input.text),
          provider: "openai-compatible-tts",
        },
        "created",
      );
    },
  };
}

function requireConfigured(config: OpenAITtsConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("TTS provider configuration is incomplete");
  }
}

async function requestAudio(
  client: ReturnType<typeof createOpenAICompatibleHttpClient>,
  model: string,
  voice: string,
  text: string,
) {
  return client.requestBytes({
    operation: "audio.speech",
    path: "/audio/speech",
    body: { model, voice, input: text, response_format: "mp3" },
  });
}

function estimateSeconds(text: string) {
  return Math.max(1, Math.round(text.length / 14));
}
