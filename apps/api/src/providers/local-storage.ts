import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageError, type AudioStorageProvider, type PutAudioInput } from "./storage";

const PREFIX = "local://";

/**
 * Local-development storage driver: writes recordings under `${DATA_DIR}/recordings`.
 * Never used in production — configure AUDIO_STORAGE_DRIVER=s3 instead.
 */
export function createLocalAudioStorage(dataDir: string): AudioStorageProvider {
  const root = path.resolve(dataDir);

  const resolveKey = (key: string) => {
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep)) throw new StorageError("invalid storage key");
    return target;
  };

  return {
    name: "local",
    async put({ key, body }: PutAudioInput) {
      try {
        const target = resolveKey(key);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body);
        return { storageKey: `${PREFIX}${key}` };
      } catch (error) {
        throw new StorageError(error instanceof Error ? error.message : "write failed");
      }
    },
    async get(storageKey: string) {
      if (!storageKey.startsWith(PREFIX)) return null;
      try {
        return await readFile(resolveKey(storageKey.slice(PREFIX.length)));
      } catch {
        return null;
      }
    },
    async remove(storageKey: string) {
      if (!storageKey.startsWith(PREFIX)) return;
      await rm(resolveKey(storageKey.slice(PREFIX.length)), { force: true });
    },
  };
}
