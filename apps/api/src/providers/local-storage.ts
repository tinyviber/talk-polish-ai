import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StorageError,
  validateStoragePathKey,
  type AudioStorageProvider,
  type PutAudioInput,
} from "./storage";

const PREFIX = "local://";

/**
 * Local-development storage driver: writes recordings under `${DATA_DIR}/recordings`.
 * Never used in production — configure AUDIO_STORAGE_DRIVER=s3 instead.
 */
export function createLocalAudioStorage(dataDir: string): AudioStorageProvider {
  const root = path.resolve(dataDir);

  const resolveKey = (key: string) => {
    validateStoragePathKey(key);
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep)) {
      throw new StorageError("invalid storage key", { code: "invalid_key" });
    }
    return target;
  };

  return {
    name: "local",
    keyFor: (key: string) => `${PREFIX}${validateStoragePathKey(key)}`,
    async check() {
      await mkdir(root, { recursive: true });
    },
    async put({ key, body }: PutAudioInput) {
      try {
        const canonicalKey = validateStoragePathKey(key);
        const target = resolveKey(canonicalKey);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body);
        return { storageKey: `${PREFIX}${canonicalKey}` };
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("local write failed", { code: "io", cause: error });
      }
    },
    async get(storageKey: string) {
      if (!storageKey.startsWith(PREFIX)) {
        throw new StorageError("invalid storage key", { code: "invalid_key" });
      }
      try {
        return await readFile(resolveKey(storageKey.slice(PREFIX.length)));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return null;
        }
        if (error instanceof StorageError) throw error;
        throw new StorageError("local read failed", { code: "io", cause: error });
      }
    },
    async remove(storageKey: string) {
      if (!storageKey.startsWith(PREFIX)) {
        throw new StorageError("invalid storage key", { code: "invalid_key" });
      }
      await rm(resolveKey(storageKey.slice(PREFIX.length)), { force: true });
    },
  };
}
