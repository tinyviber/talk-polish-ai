import type { SynthesisInput, SynthesisResult, TextToSpeechProvider } from "../tts";

/**
 * Mock TTS: returns a believable duration for the model answer player without
 * generating audio. Replace with ElevenLabs / Azure / OpenAI TTS and store the
 * generated audio through the AudioStorageProvider.
 */
export function createMockTtsProvider(): TextToSpeechProvider {
  return {
    name: "mock-tts",
    async synthesize({ text }: SynthesisInput): Promise<SynthesisResult> {
      await new Promise((r) => setTimeout(r, 100));
      return {
        storageKey: null,
        seconds: Math.max(4, Math.round(text.length / 14)),
        provider: "mock-tts",
      };
    },
  };
}
