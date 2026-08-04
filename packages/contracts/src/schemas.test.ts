import { describe, expect, test } from "bun:test";
import {
  createAnonymousLearnerRequestSchema,
  createAttemptFieldsSchema,
  expressionSchema,
  feedbackSchema,
  errorCodeSchema,
} from "./schemas";

describe("shared contracts", () => {
  test("accepts valid learner and multipart fields", () => {
    expect(
      createAnonymousLearnerRequestSchema.parse({ deviceId: "device-123456", lang: "ja" }),
    ).toEqual({ deviceId: "device-123456", lang: "ja" });
    expect(
      createAttemptFieldsSchema.parse({
        clientAttemptId: "client-attempt-123",
        attemptIndex: "2",
        durationSec: "12",
        mocked: "false",
      }),
    ).toEqual({
      clientAttemptId: "client-attempt-123",
      attemptIndex: 2,
      durationSec: 12,
      mocked: false,
    });
  });

  test("rejects invalid values and keeps error codes closed", () => {
    expect(() => createAnonymousLearnerRequestSchema.parse({ deviceId: "x" })).toThrow();
    expect(() => createAttemptFieldsSchema.parse({ attemptIndex: 3, durationSec: 1 })).toThrow();
    expect(errorCodeSchema.safeParse("not-a-real-code").success).toBe(false);
  });

  test("bounds expression ids to the database column width", () => {
    expect(
      expressionSchema.safeParse({
        id: "x".repeat(97),
        lang: "en",
        text: "hello",
        meaning: "hello",
      }).success,
    ).toBe(false);
  });

  test("accepts provider feedback fixture shape", () => {
    expect(
      feedbackSchema.parse({
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
        stats: { words: 10, wpm: 80, fillers: 1, longestPause: "1s" },
      }),
    );
  });

  test("keeps the client attempt id stable in the multipart contract", () => {
    const parsed = createAttemptFieldsSchema.parse({
      clientAttemptId: "offline-client-attempt-1",
      attemptIndex: "1",
      durationSec: "4",
    });
    expect(parsed.clientAttemptId).toBe("offline-client-attempt-1");
  });

  test("rejects fractional feedback scores that cannot fit PostgreSQL integer columns", () => {
    expect(
      feedbackSchema.safeParse({
        overall: 70.5,
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
        stats: { words: 10, wpm: 80, fillers: 1, longestPause: "1s" },
      }).success,
    ).toBe(false);
  });
});
