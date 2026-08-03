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
  /** Check provider reachability without exposing credentials. */
  check?(): Promise<void>;
  /** Optional active network probe, gated by server configuration. */
  probe?(): Promise<void>;
  /** Convert an application key into provider-specific opaque reference. */
  keyFor?(key: string): string;
}

export type StorageErrorCode =
  | "not_found"
  | "timeout"
  | "auth"
  | "network"
  | "invalid_key"
  | "io"
  | "unknown";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { code?: StorageErrorCode; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.code = options.code ?? "unknown";
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Canonical application object keys. Reject traversal and ambiguous paths. */
export function validateStoragePathKey(key: string) {
  const segments = key.split("/");
  if (
    !key ||
    key.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(key) ||
    key.includes("\\") ||
    key !== key.normalize("NFC") ||
    segments.some((part) => part.length === 0 || part === "." || part === "..") ||
    [...key].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new StorageError("invalid storage key", { code: "invalid_key" });
  }
  return key;
}
