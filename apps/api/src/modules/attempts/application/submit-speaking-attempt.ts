import type { AttemptReadyEvent } from "../domain/events";

/** Narrow application event seam; orchestration remains in service during migration. */
export type SubmitSpeakingAttemptResult = {
  attemptId: string;
  readyEvent?: AttemptReadyEvent;
};

export function toAttemptReadyEvent(input: {
  attemptId: string;
  learnerId: string;
  sessionId: string;
  attemptIndex: 1 | 2;
  overallScore: number;
}): AttemptReadyEvent {
  return { type: "AttemptReady", ...input };
}
