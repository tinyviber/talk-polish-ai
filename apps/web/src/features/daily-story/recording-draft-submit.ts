import type { DailyStoryTranscribeResult } from "./controller";
import type { DailyPhase } from "./state-machine";
import type { DailyStoryAudioPurpose } from "./audio-outbox";
import type { RecordingDraft, RecordingDraftFailureKind } from "./recording-drafts";

export const UNKNOWN_DRAFT_SUBMISSION_MESSAGE =
  "上次提交结果未知。为避免重复计费，不会自动再次提交。你可手动重新提交，或清理本机录音。";

type MergedAudio = { blob: Blob; durationSec: number };

type SubmitRecordingDraftParams = {
  conversationId: string;
  draft: RecordingDraft;
  phase: DailyPhase;
  mergeRecordedAudio: (segments: Blob[]) => Promise<MergedAudio>;
  transcribe: (
    audio: Blob,
    readAloud?: boolean,
    durationSec?: number,
    fromCache?: boolean,
    readAloudTarget?: string,
    clientAttemptIdOverride?: string,
  ) => Promise<DailyStoryTranscribeResult>;
  markSubmitting: (
    conversationId: string,
    purpose: DailyStoryAudioPurpose,
    clientAttemptId: string,
  ) => Promise<RecordingDraft | null>;
  markFailed: (
    conversationId: string,
    purpose: DailyStoryAudioPurpose,
    error: string,
    failureKind?: RecordingDraftFailureKind,
  ) => Promise<RecordingDraft | null>;
  markCompleted: (
    conversationId: string,
    purpose: DailyStoryAudioPurpose,
    input: { clientAttemptId: string; transcript: string; transcriptId: string },
  ) => Promise<RecordingDraft | null>;
  markCleanupFailed: (
    conversationId: string,
    purpose: DailyStoryAudioPurpose,
    error: string,
  ) => Promise<RecordingDraft | null>;
  removeDraft: (conversationId: string, purpose: DailyStoryAudioPurpose) => Promise<boolean>;
  onDraftChange?: (draft: RecordingDraft | null) => void;
  createAttemptId?: () => string;
};

export type SubmitRecordingDraftResult =
  | { outcome: "ignored" }
  | { outcome: "completed"; cleanupError?: string }
  | {
      outcome: "failed";
      error: string;
      failureKind: RecordingDraftFailureKind;
    };

export function shouldSubmitRecordingDraftFromCache(
  draft: Pick<RecordingDraft, "purpose">,
  phase: DailyPhase,
) {
  if (draft.purpose === "readAloud") return phase === "review" || phase === "error";
  return phase === "chatting" || phase === "error";
}

export function canCompleteRecordingDraft(draft: RecordingDraft | null) {
  if (!draft?.segments.length) return false;
  if (draft.status === "submitting" || draft.status === "completed") return false;
  if (draft.status === "failed") return true;
  return !draft.clientAttemptId;
}

export async function submitRecordingDraft({
  conversationId,
  draft,
  phase,
  mergeRecordedAudio,
  transcribe,
  markSubmitting,
  markFailed,
  markCompleted,
  markCleanupFailed,
  removeDraft,
  onDraftChange,
  createAttemptId = defaultAttemptId,
}: SubmitRecordingDraftParams): Promise<SubmitRecordingDraftResult> {
  if (!canCompleteRecordingDraft(draft)) return { outcome: "ignored" };
  try {
    const merged = await mergeRecordedAudio(draft.segments.map((segment) => segment.blob));
    const manualRetry = draft.status === "failed";
    const clientAttemptId =
      manualRetry || !draft.clientAttemptId ? createAttemptId() : draft.clientAttemptId;
    const submitting = await markSubmitting(conversationId, draft.purpose, clientAttemptId);
    if (!submitting) throw new Error("找不到录音草稿。");
    onDraftChange?.(submitting);

    const result = await transcribe(
      merged.blob,
      draft.purpose === "readAloud",
      merged.durationSec,
      shouldSubmitRecordingDraftFromCache(draft, phase),
      draft.readAloudTarget,
      clientAttemptId,
    );
    if (!result.succeeded) {
      const failureKind: RecordingDraftFailureKind = result.error ? "known" : "unknown";
      const error = result.error ?? UNKNOWN_DRAFT_SUBMISSION_MESSAGE;
      const failed = await markFailed(conversationId, draft.purpose, error, failureKind);
      onDraftChange?.(failed);
      return { outcome: "failed", error, failureKind };
    }

    const completed = await markCompleted(conversationId, draft.purpose, {
      clientAttemptId: result.clientAttemptId,
      transcript: result.transcript,
      transcriptId: result.transcriptId,
    });
    if (!completed) throw new Error("转写已完成，但结果未能保存到本机。");
    onDraftChange?.(completed);
    try {
      await removeDraft(conversationId, draft.purpose);
      onDraftChange?.(null);
      return { outcome: "completed" };
    } catch (error) {
      const text = error instanceof Error ? error.message : "录音清理失败，请重试。";
      const cleanupFailed =
        (await markCleanupFailed(conversationId, draft.purpose, text).catch(() => null)) ??
        (completed ? { ...completed, cleanupError: text } : completed);
      onDraftChange?.(cleanupFailed);
      return { outcome: "completed", cleanupError: text };
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : "录音合并失败，原始片段已保留。";
    const failed = await markFailed(conversationId, draft.purpose, text, "known").catch(() => null);
    onDraftChange?.(
      failed ?? (draft ? { ...draft, status: "failed", error: text, failureKind: "known" } : null),
    );
    return { outcome: "failed", error: text, failureKind: "known" };
  }
}

function defaultAttemptId() {
  return `asr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
