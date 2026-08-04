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

  test("keeps transcript-derived metrics while marking timing unavailable", () => {
    const result = computeSpeechMetrics({ text: "こんにちは", locale: "ja-JP" });
    expect(result.status).toBe("degraded");
    expect(result.source).toBe("transcript");
    expect(result.words).toBe(1);
    expect(result.wpm).toBeUndefined();
    expect(result.longestPauseSec).toBeUndefined();
  });
});
