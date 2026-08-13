import { describe, expect, test } from "vitest";
import type { RecordingDraft } from "@/features/daily-story/recording-drafts";
import { resolveDailyStoryErrorRetryUi } from "./daily-story-error-retry";
import { resolveRecordingDraftPurpose } from "./recording-draft-purpose";

function makeDraft(overrides: Partial<RecordingDraft> = {}): RecordingDraft {
  return {
    id: "conversation-1:readAloud",
    conversationId: "conversation-1",
    purpose: "readAloud",
    segments: [
      {
        id: "segment-1",
        draftId: "conversation-1:readAloud",
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

describe("DailyStoryPage recording draft purpose seam", () => {
  test("prefers the explicit purpose preserved before an interruption", () => {
    expect(resolveRecordingDraftPurpose("conversation", "error")).toBe("conversation");
    expect(resolveRecordingDraftPurpose("readAloud", "chatting")).toBe("readAloud");
  });

  test("falls back to the live recording phase when no explicit purpose exists", () => {
    expect(resolveRecordingDraftPurpose(null, "recording")).toBe("conversation");
    expect(resolveRecordingDraftPurpose(null, "readingAloudRecording")).toBe("readAloud");
  });

  test("rejects ambiguous interrupted callbacks without phase or preserved purpose", () => {
    expect(resolveRecordingDraftPurpose(null, "chatting")).toBeNull();
    expect(resolveRecordingDraftPurpose(null, "review")).toBeNull();
  });
});

describe("DailyStoryPage error retry entry", () => {
  test("uses the draft retry entry as the only manual path for failed transcription drafts", () => {
    expect(
      resolveDailyStoryErrorRetryUi({
        errorKind: "transcribe",
        activeDraft: makeDraft({
          status: "failed",
          clientAttemptId: "attempt-1",
          error: "ASR failed",
          failureKind: "unknown",
        }),
        cachedAudioFailed: true,
      }),
    ).toEqual({
      useDraftRetryEntry: true,
      showCachedAudioRetry: false,
      showGenericRetry: false,
    });
  });

  test("keeps legacy retry buttons for non-transcription failures", () => {
    expect(
      resolveDailyStoryErrorRetryUi({
        errorKind: "review",
        activeDraft: makeDraft({
          status: "failed",
          clientAttemptId: "attempt-1",
          error: "ASR failed",
          failureKind: "known",
        }),
        cachedAudioFailed: false,
      }),
    ).toEqual({
      useDraftRetryEntry: false,
      showCachedAudioRetry: false,
      showGenericRetry: true,
    });
  });
});
