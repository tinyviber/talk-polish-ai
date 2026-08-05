import { describe, expect, test } from "bun:test";
import { computeSpeechMetrics } from "./speech-metrics";

describe("speech metrics", () => {
  test("derives English fillers and transcript-based words", () => {
    const result = computeSpeechMetrics({ text: "Um, I went, uh, home.", durationSec: 10 });
    expect(result.words).toBe(5);
    expect(result.fillers).toBe(2);
    expect(result.wpm).toBe(30);
    expect(result.status).toBe("degraded");
  });

  test("uses timestamps for pauses and marks availability", () => {
    const result = computeSpeechMetrics({
      text: "hello world",
      segments: [
        { start: 0, end: 1, text: "hello" },
        { start: 2.2, end: 3, text: "world" },
      ],
    });
    expect(result.status).toBe("available");
    expect(result.pauseCount).toBe(1);
    expect(result.longestPauseSec).toBeCloseTo(1.2);
  });

  test("does not pretend Japanese character runs are words or WPM", () => {
    const result = computeSpeechMetrics({
      text: "あの人はこんにちは。まあ、元気です。",
      locale: "ja-JP",
      durationSec: 30,
    });
    expect(result.status).toBe("unavailable");
    expect(result.source).toBe("unavailable");
    expect(result.words).toBeUndefined();
    expect(result.wpm).toBeUndefined();
    expect(result.longestPauseSec).toBeUndefined();
    expect(result.fillers).toBe(1);
  });
});
