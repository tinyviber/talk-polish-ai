export type FeedbackDelivery = (clientAttemptId: string) => Promise<void>;

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
