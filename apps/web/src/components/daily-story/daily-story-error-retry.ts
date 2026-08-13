import { canCompleteRecordingDraft } from "@/features/daily-story/recording-draft-submit";
import type { RecordingDraft } from "@/features/daily-story/recording-drafts";

export function resolveDailyStoryErrorRetryUi({
  errorKind,
  activeDraft,
  cachedAudioFailed,
}: {
  errorKind?: "start" | "transcribe" | "reply" | "review";
  activeDraft: RecordingDraft | null;
  cachedAudioFailed: boolean;
}) {
  const useDraftRetryEntry =
    errorKind === "transcribe" &&
    !!activeDraft &&
    activeDraft.status === "failed" &&
    canCompleteRecordingDraft(activeDraft);
  return {
    useDraftRetryEntry,
    showCachedAudioRetry: cachedAudioFailed && !useDraftRetryEntry,
    showGenericRetry: !cachedAudioFailed && !useDraftRetryEntry,
  };
}
