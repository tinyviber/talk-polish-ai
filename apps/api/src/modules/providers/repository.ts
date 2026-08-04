import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { audioPlaybackReferences, audioRecordings, speakingAttempts } from "../../db/schema";
import { withDb } from "../../http/with-db";

export const providerRepository = {
  async findRecordingForLearner(learnerId: string, audioId: string) {
    const rows = await withDb("loadAudioForPlayback", () =>
      db()
        .select({ storageKey: audioRecordings.storageKey, mimeType: audioRecordings.mimeType })
        .from(audioRecordings)
        .innerJoin(speakingAttempts, eq(speakingAttempts.audioId, audioRecordings.id))
        .where(and(eq(audioRecordings.id, audioId), eq(speakingAttempts.learnerId, learnerId))),
    );
    return rows[0];
  },

  async hasPlaybackReferenceForStorageKey(storageKey: string) {
    const rows = await withDb("findAudioPlaybackReferenceByStorageKey", () =>
      db()
        .select({ id: audioPlaybackReferences.id })
        .from(audioPlaybackReferences)
        .where(eq(audioPlaybackReferences.storageKey, storageKey))
        .limit(1),
    );
    return rows.length > 0;
  },
};
