export type FeedbackDelivery = (clientAttemptId: string) => Promise<void>;

/** One in-flight IndexedDB delivery transaction per client attempt. */
export function createFeedbackDeliveryController(markFeedbackDelivered: FeedbackDelivery) {
  const inFlight = new Map<string, Promise<void>>();

  const deliverFeedbackOnce = (clientAttemptId: string) => {
    const existing = inFlight.get(clientAttemptId);
    if (existing) return existing;

    let delivery: Promise<void>;
    try {
      delivery = Promise.resolve(markFeedbackDelivered(clientAttemptId));
    } catch (error) {
      delivery = Promise.reject(error);
    }
    inFlight.set(clientAttemptId, delivery);
    void delivery.then(
      () => {
        if (inFlight.get(clientAttemptId) === delivery) inFlight.delete(clientAttemptId);
      },
      () => {
        if (inFlight.get(clientAttemptId) === delivery) inFlight.delete(clientAttemptId);
      },
    );
    return delivery;
  };

  return { deliverFeedbackOnce };
}

/** Durable application action: attempt 2 starts only after attempt 1 is consumed. */
export async function continueToSecondAttempt({
  clientAttemptId,
  markFeedbackDelivered,
  onDeliveryError,
  onSuccess,
}: {
  clientAttemptId: string | null;
  markFeedbackDelivered: FeedbackDelivery;
  onDeliveryError: (error: unknown) => void;
  onSuccess: () => void;
}) {
  try {
    if (clientAttemptId) await markFeedbackDelivered(clientAttemptId);
  } catch (error) {
    onDeliveryError(error);
    return false;
  }
  onSuccess();
  return true;
}
