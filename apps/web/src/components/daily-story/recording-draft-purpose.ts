import type { DailyStoryAudioPurpose } from "@/features/daily-story/audio-outbox";

export function resolveRecordingDraftPurpose(
  explicitPurpose: DailyStoryAudioPurpose | null,
  phase: string,
): DailyStoryAudioPurpose | null {
  if (explicitPurpose) return explicitPurpose;
  if (phase === "readingAloudRecording") return "readAloud";
  if (phase === "recording") return "conversation";
  return null;
}
