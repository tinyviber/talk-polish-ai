import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { audioPlaybackReferences } from "../../db/schema";
import { withDb } from "../../http/with-db";
import { StorageError, validateStoragePathKey } from "../../providers/storage";

export type AudioReference = {
  id: string;
  learnerId: string;
  storageKey: string;
  mimeType: string;
  expiresAt: number;
};

export type AudioReferenceStore = {
  create(reference: AudioReference): Promise<void>;
  resolve(id: string, learnerId: string, now: number): Promise<AudioReference | null>;
};

const TTL_MS = 15 * 60 * 1000;

const databaseStore: AudioReferenceStore = {
  async create(reference) {
    await withDb("createAudioPlaybackReference", () =>
      db()
        .insert(audioPlaybackReferences)
        .values({
          id: reference.id,
          learnerId: reference.learnerId,
          storageKey: reference.storageKey,
          mimeType: reference.mimeType,
          expiresAt: new Date(reference.expiresAt),
        }),
    );
  },
  async resolve(id, learnerId, now) {
    const rows = await withDb("resolveAudioPlaybackReference", () =>
      db()
        .select()
        .from(audioPlaybackReferences)
        .where(
          and(
            eq(audioPlaybackReferences.id, id),
            eq(audioPlaybackReferences.learnerId, learnerId),
            gt(audioPlaybackReferences.expiresAt, new Date(now)),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          learnerId: row.learnerId,
          storageKey: row.storageKey,
          mimeType: row.mimeType,
          expiresAt: row.expiresAt.getTime(),
        }
      : null;
  },
};

export async function issueAudioReference(
  learnerId: string,
  storageKey: string,
  mimeType: string,
  store: AudioReferenceStore = databaseStore,
): Promise<string> {
  assertStorageReference(storageKey);
  const id = randomUUID();
  await store.create({ id, learnerId, storageKey, mimeType, expiresAt: Date.now() + TTL_MS });
  return id;
}

export async function resolveAudioReference(
  reference: string,
  learnerId: string,
  store: AudioReferenceStore = databaseStore,
): Promise<AudioReference | null> {
  return store.resolve(reference, learnerId, Date.now());
}

function assertStorageReference(storageKey: string) {
  if (storageKey.startsWith("local://")) {
    validateStoragePathKey(storageKey.slice("local://".length));
    return;
  }
  if (storageKey.startsWith("s3://")) {
    const separator = storageKey.indexOf("/", "s3://".length);
    if (separator < 0) throw new StorageError("invalid storage key", { code: "invalid_key" });
    validateStoragePathKey(storageKey.slice("s3://".length, separator));
    validateStoragePathKey(storageKey.slice(separator + 1));
    return;
  }
  throw new StorageError("invalid storage key", { code: "invalid_key" });
}
