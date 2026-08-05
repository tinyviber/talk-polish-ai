import { describe, expect, test, vi } from "vitest";
import { continueToSecondAttempt } from "./recovery-controller";

describe("second-attempt application action", () => {
  test("does not enter record2 when consuming attempt one aborts", async () => {
    const onDeliveryError = vi.fn();
    const onSuccess = vi.fn();
    const result = await continueToSecondAttempt({
      clientAttemptId: "attempt-1",
      markFeedbackDelivered: vi.fn().mockRejectedValue(new Error("transaction aborted")),
      onDeliveryError,
      onSuccess,
    });

    expect(result).toBe(false);
    expect(onDeliveryError).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test("starts second attempt only after durable consume succeeds", async () => {
    const onSuccess = vi.fn();
    const result = await continueToSecondAttempt({
      clientAttemptId: "attempt-1",
      markFeedbackDelivered: vi.fn().mockResolvedValue(undefined),
      onDeliveryError: vi.fn(),
      onSuccess,
    });

    expect(result).toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
