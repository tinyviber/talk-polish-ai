import type { FrozenPracticeContext } from "../../lib/practice/workflow-context";
import type { PracticeStage } from "./state-machine";

export type RecoveryRecorderStatus = "idle" | "requesting" | "recording" | "recorded" | "denied";

/** Cross-tab recovery may only enter an untouched practice screen. */
export function canAdoptRecovery(
  stage: PracticeStage,
  frozenContext: FrozenPracticeContext | null,
  recorderStatus: RecoveryRecorderStatus,
) {
  return (
    stage === "prompt" &&
    frozenContext === null &&
    (recorderStatus === "idle" || recorderStatus === "denied")
  );
}

/** A ready row may hydrate an already active page only within same client session. */
export function belongsToFrozenSession(
  clientSessionId: string,
  frozenContext: FrozenPracticeContext | null,
) {
  return frozenContext === null || clientSessionId === frozenContext.clientSessionId;
}
