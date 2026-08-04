import type { Lang } from "@kotoba/contracts";

export type SynthesisInput = {
  text: string;
  lang: Lang;
  voice?: string;
  purpose?: "prompt" | "answer" | "expression";
  /** Server-owned cache scope; never accept this from browser input. */
  scope?: string;
};

export type SynthesisResult = {
  /** Storage reference for generated audio, or null for mock providers. */
  storageKey: string | null;
  contentType?: string;
  seconds: number;
  provider: string;
};

export type SynthesisStorageDisposition = "cache-hit" | "created";

const synthesisStorageDisposition = new WeakMap<SynthesisResult, SynthesisStorageDisposition>();

export function withSynthesisStorageDisposition<T extends SynthesisResult>(
  result: T,
  disposition: SynthesisStorageDisposition,
) {
  synthesisStorageDisposition.set(result, disposition);
  return result;
}

export function getSynthesisStorageDisposition(result: SynthesisResult) {
  return synthesisStorageDisposition.get(result);
}

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
  check?(): Promise<void>;
  probe?(): Promise<void>;
}
