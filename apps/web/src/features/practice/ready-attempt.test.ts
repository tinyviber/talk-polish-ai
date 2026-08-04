import { describe, expect, test, vi } from "vitest";
import { ApiClientError } from "../../lib/practice/api";
import type { RecordingQueueItem } from "../../lib/practice/offlineQueue";
import { findReadyRecording, loadReadyAttempt } from "./ready-attempt";

const readyItem = {
  learnerId: "device:learner-1",
  clientAttemptId: "client-attempt-1",
  sessionId: "session-1",
  clientSessionId: "client-session-1",
  promptId: "prompt-1",
  lang: "en" as const,
  attemptIndex: 1 as const,
  duration: 2,
  mimeType: "audio/webm",
  blob: new Blob([], { type: "audio/webm" }),
  createdAt: 1,
  syncStatus: "ready" as const,
  attemptId: "server-attempt-1",
} satisfies RecordingQueueItem;

const readyResponse = {
  id: "server-attempt-1",
  clientAttemptId: "client-attempt-1",
  sessionId: "session-1",
  index: 1 as const,
  status: "ready" as const,
  transcript: "A useful answer.",
  transcription: {},
  feedback: {
    overall: 70,
    headline: "Good",
    scores: {
      fluency: 70,
      pauses: 70,
      grammar: 70,
      vocabulary: 70,
      naturalness: 70,
      pronunciation: 70,
    },
    improvements: [],
    annotations: [],
    expressions: [],
    stats: { words: 3, wpm: 80, fillers: 0, longestPause: "1s" },
  },
  durationSec: 2,
  mocked: false,
  audio: null,
  createdAt: "2026-08-05T00:00:00.000Z",
};

describe("durable ready attempt recovery", () => {
  test("finds matching ready metadata from another tab's durable queue view", () => {
    expect(findReadyRecording([readyItem], readyItem.clientAttemptId)).toEqual(readyItem);
    expect(
      findReadyRecording([{ ...readyItem, syncStatus: "queued" }], readyItem.clientAttemptId),
    ).toBe(null);
  });

  test("keeps ready state when feedback read times out, then succeeds without upload", async () => {
    const readAttempt = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("Timed out", 0, "network_error"))
      .mockResolvedValueOnce(readyResponse);

    const firstRead = await loadReadyAttempt(readyItem, readAttempt);
    expect(firstRead?.status).toBe("retry");

    const secondRead = await loadReadyAttempt(readyItem, readAttempt);
    expect(secondRead?.status).toBe("ready");
    expect(readAttempt).toHaveBeenCalledTimes(2);
    expect(readyItem.syncStatus).toBe("ready");
    expect(readyItem.attemptId).toBe("server-attempt-1");
  });
});
