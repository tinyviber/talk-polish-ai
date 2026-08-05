import { describe, expect, test, vi } from "vitest";
import { createFeedbackDeliveryController, continueToSecondAttempt } from "./recovery-controller";

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

  test("shares one delivery promise between concurrent callers", async () => {
    let resolveDelivery: (() => void) | null = null;
    const markFeedbackDelivered = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    const controller = createFeedbackDeliveryController(markFeedbackDelivered);

    const first = controller.deliverFeedbackOnce("attempt-1");
    const second = controller.deliverFeedbackOnce("attempt-1");
    expect(first).toBe(second);
    expect(markFeedbackDelivered).toHaveBeenCalledOnce();

    resolveDelivery!();
    await Promise.all([first, second]);
  });

  test("allows retry after a failed shared delivery", async () => {
    const markFeedbackDelivered = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transaction aborted"))
      .mockResolvedValueOnce(undefined);
    const controller = createFeedbackDeliveryController(markFeedbackDelivered);

    await expect(controller.deliverFeedbackOnce("attempt-1")).rejects.toThrow(
      "transaction aborted",
    );
    await expect(controller.deliverFeedbackOnce("attempt-1")).resolves.toBeUndefined();
    expect(markFeedbackDelivered).toHaveBeenCalledTimes(2);
  });
});
