import { fixtureTranscript } from "@kotoba/contracts";
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "../transcription";

/**
 * Deterministic mock ASR. Replace this file (and the registry entry in
 * `apps/api/src/providers/index.ts`) with a Whisper/Deepgram/etc. client.
 */
export function createMockTranscriptionProvider(): TranscriptionProvider {
  return {
    name: "mock-asr",
    async check() {},
    async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
      await new Promise((r) => setTimeout(r, 350));
      return {
        text: fixtureTranscript(input.promptId, input.lang, input.attemptIndex),
        mocked: input.audio === null,
        provider: "mock-asr",
      };
    },
  };
}
