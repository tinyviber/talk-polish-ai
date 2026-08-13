import { DAILY_STORY_LIMITS } from "@kotoba/contracts";

/** Maximum number of characters accepted for one Daily Story turn. */
export const DAILY_STORY_TURN_MAX = DAILY_STORY_LIMITS.turnChars;

export type DailyStoryCachedAudio = {
  clientAttemptId: string;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: number;
  status: "queued" | "uploading" | "failed" | "completed";
  purpose: "conversation" | "readAloud";
  readAloudTarget?: string;
  error?: string;
};

export type DailyStoryTranscribeResult =
  | {
      succeeded: true;
      clientAttemptId: string;
      transcript: string;
      transcriptId: string;
    }
  | {
      succeeded: false;
      clientAttemptId: string;
      error?: string;
    };
