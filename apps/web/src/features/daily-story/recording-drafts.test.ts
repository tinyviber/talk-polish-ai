import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  closeNextFakeIndexedDbTransaction,
  installFakeIndexedDb,
} from "@/lib/practice/test/fakeIndexedDb";
import {
  appendRecordingDraftSegment,
  getRecordingDraft,
  getRecordingDrafts,
  __resetRecordingDraftsForTests,
  markRecordingDraftCompleted,
  markRecordingDraftFailed,
  markRecordingDraftSubmitting,
  removeRecordingDraft,
} from "./recording-drafts";

let restoreIndexedDb: () => void;

beforeAll(() => {
  restoreIndexedDb = installFakeIndexedDb();
});
beforeEach(() => __resetRecordingDraftsForTests());
afterAll(() => restoreIndexedDb());

describe("recording drafts", () => {
  test("appends ordered segments without mixing purposes or conversations", async () => {
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      segmentId: "segment-1",
    });
    const saved = await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["two"], { type: "audio/mp4" }),
      mimeType: "audio/mp4",
      durationSec: 3,
      segmentId: "segment-2",
    });
    expect(saved.segments.map((segment) => segment.sequence)).toEqual([0, 1]);
    expect(saved.totalDurationSec).toBe(5);
    expect(await getRecordingDraft("conversation-1", "readAloud")).toBeNull();
    expect(await getRecordingDraft("conversation-2", "conversation")).toBeNull();
  });

  test("removes all segment records only for the selected draft", async () => {
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      segmentId: "segment-1",
    });
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "readAloud",
      readAloudTarget: "I went home.",
      blob: new Blob(["read"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      segmentId: "segment-read",
    });
    await removeRecordingDraft("conversation-1", "conversation");
    expect(await getRecordingDraft("conversation-1", "conversation")).toBeNull();
    expect(await getRecordingDraft("conversation-1", "readAloud")).not.toBeNull();
  });

  test("recovers from a closed active transaction and restores both purposes", async () => {
    closeNextFakeIndexedDbTransaction();
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      segmentId: "segment-1",
    });
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "readAloud",
      readAloudTarget: "I went home.",
      blob: new Blob(["read"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 1,
      segmentId: "segment-read",
    });

    const drafts = await getRecordingDrafts("conversation-1");
    expect(drafts.conversation?.segments).toHaveLength(1);
    expect(drafts.readAloud?.readAloudTarget).toBe("I went home.");
  });

  test("treats draft submission as idempotent by clientAttemptId", async () => {
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      segmentId: "segment-1",
    });

    const submitting = await markRecordingDraftSubmitting(
      "conversation-1",
      "conversation",
      "attempt-1",
    );
    expect(submitting).toMatchObject({ status: "submitting", clientAttemptId: "attempt-1" });

    const repeatedSubmitting = await markRecordingDraftSubmitting(
      "conversation-1",
      "conversation",
      "attempt-2",
    );
    expect(repeatedSubmitting).toMatchObject({
      status: "submitting",
      clientAttemptId: "attempt-1",
    });

    const completed = await markRecordingDraftCompleted("conversation-1", "conversation", {
      clientAttemptId: "attempt-1",
      transcript: "hello there",
      transcriptId: "transcript-1",
    });
    expect(completed).toMatchObject({
      status: "completed",
      clientAttemptId: "attempt-1",
      transcript: "hello there",
      transcriptId: "transcript-1",
    });

    const ignoredResubmit = await markRecordingDraftSubmitting(
      "conversation-1",
      "conversation",
      "attempt-2",
    );
    expect(ignoredResubmit).toMatchObject({
      status: "completed",
      clientAttemptId: "attempt-1",
      transcript: "hello there",
    });
  });

  test("clears stale submission metadata when the user appends a new segment", async () => {
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      segmentId: "segment-1",
    });
    await markRecordingDraftCompleted("conversation-1", "conversation", {
      clientAttemptId: "attempt-1",
      transcript: "hello there",
      transcriptId: "transcript-1",
    });

    const renewed = await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["two"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 3,
      segmentId: "segment-2",
    });

    expect(renewed).toMatchObject({
      status: "draft",
      totalDurationSec: 5,
      totalBytes: expect.any(Number),
    });
    expect(renewed.clientAttemptId).toBeUndefined();
    expect(renewed.transcript).toBeUndefined();
    expect(renewed.transcriptId).toBeUndefined();
    expect(renewed.cleanupError).toBeUndefined();
    expect(renewed.error).toBeUndefined();
    expect(renewed.failureKind).toBeUndefined();
  });

  test("persists failed submission kind and clears it after a fresh manual retry", async () => {
    await appendRecordingDraftSegment({
      conversationId: "conversation-1",
      purpose: "conversation",
      blob: new Blob(["one"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationSec: 2,
      segmentId: "segment-1",
    });

    const failed = await markRecordingDraftFailed(
      "conversation-1",
      "conversation",
      "结果未知。",
      "unknown",
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: "结果未知。",
      failureKind: "unknown",
    });

    const resubmitting = await markRecordingDraftSubmitting(
      "conversation-1",
      "conversation",
      "attempt-2",
    );
    expect(resubmitting).toMatchObject({
      status: "submitting",
      clientAttemptId: "attempt-2",
    });
    expect(resubmitting?.error).toBeUndefined();
    expect(resubmitting?.failureKind).toBeUndefined();
  });
});
