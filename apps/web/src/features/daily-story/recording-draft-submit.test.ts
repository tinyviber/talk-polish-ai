import { describe, expect, test, vi } from "vitest";
import {
  canCompleteRecordingDraft,
  submitRecordingDraft,
  UNKNOWN_DRAFT_SUBMISSION_MESSAGE,
} from "./recording-draft-submit";
import type { RecordingDraft } from "./recording-drafts";

function makeDraft(overrides: Partial<RecordingDraft> = {}): RecordingDraft {
  return {
    id: "conversation-1:conversation",
    conversationId: "conversation-1",
    purpose: "conversation",
    segments: [
      {
        id: "segment-1",
        draftId: "conversation-1:conversation",
        sequence: 0,
        blob: new Blob(["one"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationSec: 2,
        createdAt: 1,
      },
    ],
    totalDurationSec: 2,
    totalBytes: 3,
    createdAt: 1,
    updatedAt: 1,
    status: "draft",
    ...overrides,
  };
}

describe("recording draft submission", () => {
  test("restored conversation draft in chatting submits through the cached path once", async () => {
    const draft = makeDraft();
    const merged = { blob: new Blob(["merged"], { type: "audio/wav" }), durationSec: 2 };
    const markSubmitting = vi.fn().mockResolvedValue({
      ...draft,
      status: "submitting",
      clientAttemptId: "attempt-1",
    });
    const transcribe = vi.fn().mockResolvedValue({
      succeeded: true,
      clientAttemptId: "attempt-1",
      transcript: "hello there",
      transcriptId: "transcript-1",
    });
    const markCompleted = vi.fn().mockResolvedValue({
      ...draft,
      status: "completed",
      clientAttemptId: "attempt-1",
      transcript: "hello there",
      transcriptId: "transcript-1",
    });
    const transitions: Array<string | null> = [];

    const result = await submitRecordingDraft({
      conversationId: "conversation-1",
      draft,
      phase: "chatting",
      mergeRecordedAudio: vi.fn().mockResolvedValue(merged),
      transcribe,
      markSubmitting,
      markFailed: vi.fn(),
      markCompleted,
      markCleanupFailed: vi.fn(),
      removeDraft: vi.fn().mockResolvedValue(true),
      onDraftChange: (next) => transitions.push(next?.status ?? null),
      createAttemptId: () => "attempt-1",
    });

    expect(result).toEqual({ outcome: "completed" });
    expect(markSubmitting).toHaveBeenCalledWith("conversation-1", "conversation", "attempt-1");
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(
      merged.blob,
      false,
      merged.durationSec,
      true,
      undefined,
      "attempt-1",
    );
    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual(["submitting", "completed", null]);
  });

  test("failed draft stays manually retryable with a fresh attempt id", async () => {
    const draft = makeDraft({
      status: "failed",
      clientAttemptId: "attempt-old",
      error: "服务暂时不可用。",
      failureKind: "known",
    });
    const markFailed = vi.fn().mockResolvedValue({
      ...draft,
      status: "failed",
      clientAttemptId: "attempt-new",
      error: "服务暂时不可用。",
      failureKind: "known",
    });
    const transcribe = vi.fn().mockResolvedValue({
      succeeded: false,
      clientAttemptId: "attempt-new",
      error: "服务暂时不可用。",
    });

    const result = await submitRecordingDraft({
      conversationId: "conversation-1",
      draft,
      phase: "chatting",
      mergeRecordedAudio: vi.fn().mockResolvedValue({
        blob: new Blob(["merged"], { type: "audio/wav" }),
        durationSec: 2,
      }),
      transcribe,
      markSubmitting: vi.fn().mockResolvedValue({
        ...draft,
        status: "submitting",
        clientAttemptId: "attempt-new",
      }),
      markFailed,
      markCompleted: vi.fn(),
      markCleanupFailed: vi.fn(),
      removeDraft: vi.fn(),
      createAttemptId: () => "attempt-new",
    });

    expect(result).toEqual({
      outcome: "failed",
      error: "服务暂时不可用。",
      failureKind: "known",
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(
      expect.any(Blob),
      false,
      2,
      true,
      undefined,
      "attempt-new",
    );
    expect(markFailed).toHaveBeenCalledWith(
      "conversation-1",
      "conversation",
      "服务暂时不可用。",
      "known",
    );
  });

  test("marks unknown submission outcome without auto retry", async () => {
    const draft = makeDraft({ status: "failed", clientAttemptId: "attempt-old", error: "旧错误" });
    const markFailed = vi.fn().mockResolvedValue({
      ...draft,
      status: "failed",
      clientAttemptId: "attempt-new",
      error: UNKNOWN_DRAFT_SUBMISSION_MESSAGE,
      failureKind: "unknown",
    });

    const result = await submitRecordingDraft({
      conversationId: "conversation-1",
      draft,
      phase: "chatting",
      mergeRecordedAudio: vi.fn().mockResolvedValue({
        blob: new Blob(["merged"], { type: "audio/wav" }),
        durationSec: 2,
      }),
      transcribe: vi.fn().mockResolvedValue({
        succeeded: false,
        clientAttemptId: "attempt-new",
      }),
      markSubmitting: vi.fn().mockResolvedValue({
        ...draft,
        status: "submitting",
        clientAttemptId: "attempt-new",
      }),
      markFailed,
      markCompleted: vi.fn(),
      markCleanupFailed: vi.fn(),
      removeDraft: vi.fn(),
      createAttemptId: () => "attempt-new",
    });

    expect(result).toEqual({
      outcome: "failed",
      error: UNKNOWN_DRAFT_SUBMISSION_MESSAGE,
      failureKind: "unknown",
    });
    expect(markFailed).toHaveBeenCalledWith(
      "conversation-1",
      "conversation",
      UNKNOWN_DRAFT_SUBMISSION_MESSAGE,
      "unknown",
    );
  });

  test("permits failed drafts but still blocks submitting and completed ones", () => {
    expect(canCompleteRecordingDraft(makeDraft())).toBe(true);
    expect(
      canCompleteRecordingDraft(makeDraft({ status: "failed", clientAttemptId: "attempt-1" })),
    ).toBe(true);
    expect(canCompleteRecordingDraft(makeDraft({ status: "submitting" }))).toBe(false);
    expect(canCompleteRecordingDraft(makeDraft({ status: "completed" }))).toBe(false);
  });
});
