import type { Lang, TranscriptionMetadata } from "@kotoba/contracts";

export type TranscriptionInput = {
  lang: Lang;
  promptId: string;
  attemptIndex: 1 | 2;
  durationSec: number;
  audio: { storageKey: string; mimeType: string; bytes: number } | null;
};

export type TranscriptionResult = {
  text: string;
  transcription?: TranscriptionMetadata;
  /** True when no real audio was analysed (demo / mic-blocked fallback). */
  mocked: boolean;
  provider: string;
};

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
  check?(): Promise<void>;
  probe?(): Promise<void>;
}

export class ProviderUnavailableError extends Error {}
