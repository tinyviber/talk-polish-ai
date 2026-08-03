export type PracticeStage =
  | "prompt"
  | "record"
  | "recording"
  | "recorded"
  | "uploading"
  | "processing"
  | "feedback"
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
  | { type: "offline"; attemptIndex: 1 | 2 }
  | { type: "retry"; attemptIndex: 1 | 2 }
  | { type: "failed"; message: string; attemptIndex: 1 | 2 }
  | { type: "next-prompt" };

export const initialPracticeState: PracticeState = {
  stage: "prompt",
  attemptIndex: 1,
  error: null,
};

/** Pure practice workflow transition. Side effects stay in route/application adapters. */
export function reducePracticeState(
  state: PracticeState,
  event: PracticeEvent,
): PracticeState {
  switch (event.type) {
    case "begin":
      return { ...state, stage: "record", error: null };
    case "recording":
      return { ...state, stage: "recording", error: null };
    case "recorded":
      return { ...state, stage: "recorded", error: null };
    case "submit":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "uploading" : "processing2",
        error: null,
      };
    case "processing":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "processing" : "processing2",
        error: null,
      };
    case "ready":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "feedback" : "result",
        error: null,
      };
    case "offline":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: "offline-recovery",
        error: null,
      };
    case "retry":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: "retry",
        error: null,
      };
    case "failed":
      return {
        ...state,
        attemptIndex: event.attemptIndex,
        stage: event.attemptIndex === 1 ? "record" : "record2",
        error: event.message,
      };
    case "next-prompt":
      return initialPracticeState;
  }
}

export function transitionTo(state: PracticeState, stage: PracticeStage): PracticeState {
  if (stage === "prompt") return initialPracticeState;
  const attemptIndex: 1 | 2 =
    stage === "record2" || stage === "processing2" || stage === "result" ? 2 : state.attemptIndex;
  return { ...state, stage, attemptIndex, error: null };
}
