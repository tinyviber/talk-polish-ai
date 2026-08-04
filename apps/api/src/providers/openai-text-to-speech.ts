import type { TextToSpeech } from "../capabilities/text-to-speech";
import { createOpenAICompatibleHttpClient, ProviderConfigurationError } from "./http";

export type OpenAITextToSpeechConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice: string;
  timeoutMs: number;
  maxAttempts: number;
};

/** Pure TTS transport. It returns bytes; cache/storage policy is application-owned. */
export function createOpenAICompatibleTextToSpeech(config: OpenAITextToSpeechConfig): TextToSpeech {
  const client = createOpenAICompatibleHttpClient({ capability: "tts", ...config });
  return {
    name: "openai-compatible-tts",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await synthesizeBytes(client, config, "ping");
    },
    async synthesize(input) {
      requireConfigured(config);
      const bytes = await synthesizeBytes(client, config, input.text, input.voice);
      return {
        bytes: new Uint8Array(bytes),
        contentType: input.format === "wav" ? "audio/wav" : "audio/mpeg",
        provider: "openai-compatible-tts",
      };
    },
  };
}

function requireConfigured(config: OpenAITextToSpeechConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("TTS provider configuration is incomplete");
  }
}

async function synthesizeBytes(
  client: ReturnType<typeof createOpenAICompatibleHttpClient>,
  config: OpenAITextToSpeechConfig,
  text: string,
  voice = config.voice,
) {
  return client.requestBytes({
    operation: "audio.speech",
    path: "/audio/speech",
    body: { model: config.model, voice, input: text, response_format: "mp3" },
  });
}
