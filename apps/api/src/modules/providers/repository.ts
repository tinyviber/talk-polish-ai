import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { audioRecordings, speakingAttempts } from "../../db/schema";
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
};
