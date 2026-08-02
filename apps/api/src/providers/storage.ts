/**
 * Audio storage abstraction.
 *
 * Route and domain code only ever sees `storageKey` strings, so swapping the
 * local driver for an S3-compatible one (see `s3.ts.example` guidance in the
 * README) requires no changes outside this folder.
 */
export type PutAudioInput = {
  /** Path-like key, e.g. `recordings/<attemptId>.webm`. */
  key: string;
  body: Buffer;
  contentType: string;
};

export interface AudioStorageProvider {
  readonly name: string;
  put(input: PutAudioInput): Promise<{ storageKey: string }>;
  /** Raw bytes, for providers that re-read the audio (real ASR). */
  get(storageKey: string): Promise<Buffer | null>;
  remove(storageKey: string): Promise<void>;
}

export class StorageError extends Error {}
