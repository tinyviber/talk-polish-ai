import { describe, expect, test } from "vitest";
import { dailyReducer, initialDailyState, snapshotDailyState } from "./state-machine";

const op = { operationId: "op-1", settingsRevision: 4 };

describe("Daily Story reducer", () => {
  test("ignores stale async completion", () => {
    const starting = dailyReducer(
      { ...initialDailyState, phase: "compose", draft: "今天下雨" },
      { type: "startRequest", ...op, storyZh: "今天下雨" },
    );
    const stale = dailyReducer(starting, {
      type: "startSuccess",
      operationId: "other",
      settingsRevision: 4,
      opening: { id: "ai", role: "assistant", text: "How was your day?" },
    });
    expect(stale).toEqual(starting);
  });

  test("keeps ASR transcript readonly until user explicitly sends", () => {
    const recording = { ...initialDailyState, phase: "recording" as const, storyZh: "故事" };
    const transcribing = dailyReducer(recording, { type: "transcribeRequest", ...op });
    const ready = dailyReducer(transcribing, {
      type: "transcribeSuccess",
      ...op,
      transcript: { id: "asr-1", source: "asr", text: "I was nervous." },
    });
    expect(ready.phase).toBe("transcriptReady");
    expect(ready.messages).toHaveLength(0);
    expect(ready.pendingTranscript?.text).toBe("I was nervous.");
  });

  test("returns from denied or unsupported recording to text fallback", () => {
    const recording = { ...initialDailyState, phase: "recording" as const, storyZh: "故事" };
    expect(dailyReducer(recording, { type: "recordingCancelled" }).phase).toBe("chatting");
  });

  test("drops stale provider completion after settings revision changes", () => {
    const waiting = dailyReducer(
      {
        ...initialDailyState,
        phase: "chatting",
        storyZh: "故事",
        settingsRevision: 4,
      },
      {
        type: "sendRequest",
        ...op,
        turn: { id: "typed-1", source: "typed", text: "I felt better." },
      },
    );
    const invalidated = dailyReducer(waiting, {
      type: "settingsRevisionChanged",
      settingsRevision: 5,
    });
    expect(invalidated.phase).toBe("chatting");
    expect(invalidated.operation).toBeNull();
    const stale = dailyReducer(invalidated, {
      type: "replySuccess",
      ...op,
      turn: { id: "typed-1", source: "typed", text: "I felt better." },
      assistant: { id: "ai", role: "assistant", text: "Tell me more." },
    });
    expect(stale).toEqual(invalidated);
  });

  test("binds read-aloud recording to selected improved sentence", () => {
    const review = { ...initialDailyState, phase: "review" as const, storyZh: "故事" };
    const recording = dailyReducer(review, {
      type: "readAloudRecording",
      target: "I shared my idea in the meeting.",
    });
    expect(recording.phase).toBe("readingAloudRecording");
    expect(recording.readAloudTarget).toBe("I shared my idea in the meeting.");
  });

  test("returns to unchanged review after repeat-expression cancellation or success", () => {
    const review = {
      ...initialDailyState,
      phase: "review" as const,
      storyZh: "故事",
      review: {
        suggestions: [
          {
            sourceTurnId: "user-1",
            original: "I go to office yesterday.",
            improved: "I went to the office yesterday.",
            category: "grammar" as const,
            explanationZh: "Use past tense for yesterday.",
          },
        ],
      },
    };
    const recording = dailyReducer(review, {
      type: "readAloudRecording",
      target: "I went to the office yesterday.",
    });

    expect(dailyReducer(recording, { type: "resetReadAloud" })).toMatchObject({
      phase: "review",
      review: review.review,
    });

    const retry = dailyReducer(recording, {
      type: "transcribeRequest",
      ...op,
      readAloud: true,
    });
    const completed = dailyReducer(retry, {
      type: "transcribeSuccess",
      ...op,
      readAloud: true,
      transcript: { id: "read-1", source: "asr", text: "I went to the office yesterday." },
    });
    expect(completed).toMatchObject({
      phase: "review",
      review: review.review,
      readAloudTranscript: "I went to the office yesterday.",
    });
  });

  test("persists stable allowlist only", () => {
    const state = {
      ...initialDailyState,
      phase: "transcriptReady" as const,
      storyZh: "故事",
      messages: [{ id: "ai", role: "assistant" as const, text: "Tell me more." }],
      pendingTranscript: { id: "asr", source: "asr" as const, text: "I went home." },
      revision: 2,
      operation: { id: "secret-op", settingsRevision: 9 },
    };
    expect(snapshotDailyState(state)).toEqual({
      phase: "transcriptReady",
      storyZh: "故事",
      messages: [{ id: "ai", role: "assistant", text: "Tell me more." }],
      pendingAsrTranscript: { id: "asr", text: "I went home." },
    });
  });
});
