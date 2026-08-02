import type { Lang } from "@kotoba/contracts";

export type SynthesisInput = {
  text: string;
  lang: Lang;
  voice?: string;
};

export type SynthesisResult = {
  /** Storage reference for generated audio, or null for mock providers. */
  storageKey: string | null;
  seconds: number;
  provider: string;
};

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}
