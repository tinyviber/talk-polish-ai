export type PracticeStage =
  | "prompt"
  | "record"
  | "recording"
  | "recorded"
  | "uploading"
  | "processing"
  | "feedback"
  | "feedback-recovery"
  | "record2"
  | "processing2"
  | "result"
  | "offline-recovery"
  | "retry";

export type PracticeState = {
  stage: PracticeStage;
  attemptIndex: 1 | 2;
  error: string | null;
};

export type PracticeEvent =
  | { type: "begin" }
  | { type: "recording" }
  | { type: "recorded" }
  | { type: "submit"; attemptIndex: 1 | 2 }
  | { type: "processing"; attemptIndex: 1 | 2 }
  | { type: "ready"; attemptIndex: 1 | 2 }
  | { type: "feedback-load-failed"; message: string; attemptIndex: 1 | 2 }
  | { type: "feedback-retry-requested" }
  | { type: "offline"; attemptIndex: 1 | 2 }
  | { type: "retry"; attemptIndex: 1 | 2 }
  | { type: "failed"; message: string; attemptIndex: 1 | 2 }
  | { type: "second-attempt-started" }
  | { type: "workflow-completed" }
  | { type: "next-prompt" };

export const initialPracticeState: PracticeState = {
  stage: "prompt",
  attemptIndex: 1,
  error: null,
};

function unchanged(state: PracticeState) {
  return state;
}

/** Pure workflow transition. Invalid events are rejected by keeping state. */
export function reducePracticeState(state: PracticeState, event: PracticeEvent): PracticeState {
  switch (event.type) {
    case "begin":
      return state.stage === "prompt"
        ? { ...state, stage: "record", error: null }
        : unchanged(state);
    case "recording":
      return state.stage === "record" || state.stage === "record2"
        ? { ...state, stage: "recording", error: null }
        : unchanged(state);
    case "recorded":
      return state.stage === "recording" ? { ...state, stage: "recorded", error: null } : state;
    case "submit":
      if (state.stage !== "recorded" || state.attemptIndex !== event.attemptIndex) return state;
      return {
        ...state,
        stage: event.attemptIndex === 1 ? "uploading" : "processing2",
        error: null,
      };
    case "processing":
      if (event.attemptIndex === 1 && state.stage !== "uploading" && state.stage !== "processing")
        return state;
      if (event.attemptIndex === 2 && state.stage !== "processing2" && state.stage !== "recorded")
        return state;
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "processing" : "processing2",
        error: null,
      };
    case "ready":
      if (
        event.attemptIndex === 1 &&
        state.stage !== "processing" &&
        state.stage !== "uploading" &&
        state.stage !== "feedback-recovery"
      )
        return state;
      if (
        event.attemptIndex === 2 &&
        state.stage !== "processing2" &&
        state.stage !== "feedback-recovery"
      )
        return state;
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "feedback" : "result",
        error: null,
      };
    case "feedback-load-failed":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: "feedback-recovery",
        error: event.message,
      };
    case "feedback-retry-requested":
      return state.stage === "feedback-recovery" ? { ...state, error: null } : state;
    case "offline":
      if (state.stage !== "recorded" && state.stage !== "processing") return state;
      return { ...state, attemptIndex: event.attemptIndex, stage: "offline-recovery", error: null };
    case "retry":
      return state.stage === "offline-recovery" || state.stage === "retry"
        ? { ...state, attemptIndex: event.attemptIndex, stage: "retry", error: null }
        : state;
    case "failed":
      if (state.stage === "feedback-recovery") return state;
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "record" : "record2",
        error: event.message,
      };
    case "second-attempt-started":
      return state.stage === "feedback"
        ? { ...state, attemptIndex: 2, stage: "record2", error: null }
        : state;
    case "workflow-completed":
      return state.stage === "processing2" || state.stage === "feedback"
        ? { ...state, stage: "result", error: null }
        : state;
    case "next-prompt":
      return initialPracticeState;
  }
}
