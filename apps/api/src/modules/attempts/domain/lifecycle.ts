export type AttemptLifecycleState = "processing" | "ready" | "failed";

export type AttemptLifecycleEvent =
  "claimed" | "completed" | "failed" | "recovered-stale" | "reclaimed-failed";

const transitions: Record<
  AttemptLifecycleState,
  Partial<Record<AttemptLifecycleEvent, AttemptLifecycleState>>
> = {
  processing: { completed: "ready", failed: "failed", "recovered-stale": "failed" },
  failed: { "reclaimed-failed": "processing" },
  ready: {},
};

export function transitionAttempt(
  state: AttemptLifecycleState,
  event: AttemptLifecycleEvent,
): AttemptLifecycleState | null {
  return transitions[state][event] ?? null;
}

export function isTerminalAttemptState(state: AttemptLifecycleState) {
  return state === "ready" || state === "failed";
}
