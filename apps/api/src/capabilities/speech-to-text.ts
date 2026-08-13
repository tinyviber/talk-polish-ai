export type TranscriptSegment = {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  confidence?: number;
};

export type TranscriptWord = {
  word: string;
  start?: number;
  end?: number;
  confidence?: number;
};

export type Transcript = {
  text: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  confidence?: number;
  provider: string;
};

/** ASR only sees bytes and locale. Storage/product workflow stays outside. */
export interface SpeechToText {
  readonly name: string;
  transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    locale?: string;
    granularity?: "text" | "segment" | "word";
    requestId?: string;
  }): Promise<Transcript>;
  check?(requestId?: string): Promise<void>;
  probe?(requestId?: string): Promise<void>;
}
