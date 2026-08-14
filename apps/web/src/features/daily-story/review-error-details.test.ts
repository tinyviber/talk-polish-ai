import { describe, expect, test } from "vitest";
import {
  DAILY_REVIEW_ERROR_DETAIL_MAX_CHARS,
  formatDailyReviewErrorDetails,
} from "./review-error-details";

describe("Daily Story review error details", () => {
  test("formats raw errors and truncates each line independently", () => {
    const longError = "x".repeat(DAILY_REVIEW_ERROR_DETAIL_MAX_CHARS + 20);

    expect(formatDailyReviewErrorDetails({ errors: ["rubric is invalid", longError] })).toEqual([
      "rubric is invalid",
      `${"x".repeat(DAILY_REVIEW_ERROR_DETAIL_MAX_CHARS)}…`,
    ]);
  });

  test("serializes object errors and tolerates empty details", () => {
    expect(formatDailyReviewErrorDetails([{ path: ["rubric"], code: "custom" }])).toEqual([
      '{"path":["rubric"],"code":"custom"}',
    ]);
    expect(formatDailyReviewErrorDetails(undefined)).toEqual([]);
    expect(formatDailyReviewErrorDetails(null)).toEqual([]);
  });
});
