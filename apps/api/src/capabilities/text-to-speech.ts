export type SynthesizedAudio = {
  bytes: Uint8Array;
  contentType: string;
  durationSec?: number;
  provider: string;
};

/** TTS transport port. Cache, storage, learner scope, and purpose stay outside. */
export interface TextToSpeech {
  readonly name: string;
  synthesize(input: {
    text: string;
    voice?: string;
    locale?: string;
    format?: string;
    requestId?: string;
  }): Promise<SynthesizedAudio>;
  check?(requestId?: string): Promise<void>;
  probe?(): Promise<void>;
}
