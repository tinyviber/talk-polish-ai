import type { AudioStorageProvider } from "../../providers/storage";

export async function readCachedAudio(storage: AudioStorageProvider, key: string) {
  return storage.get(storage.keyFor?.(key) ?? key);
}

export async function writeCachedAudio(
  storage: AudioStorageProvider,
  key: string,
  bytes: Uint8Array,
  contentType: string,
) {
  return storage.put({ key, body: Buffer.from(bytes), contentType });
}
