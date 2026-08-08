import type { DailyMessage, DailyReview, StorySession, TurnSource } from "./types";

export type DailyPhase =
  | "loading"
  | "compose"
  | "starting"
  | "chatting"
  | "recording"
  | "transcribing"
  | "transcriptReady"
  | "waitingForAi"
  | "reviewing"
  | "review"
  | "readingAloudRecording"
  | "readingAloudTranscribing"
  | "error";

type StablePhase = "chatting" | "transcriptReady" | "review";
type PendingTurn = { id: string; source: TurnSource; text: string };

export type DailyState = {
  phase: DailyPhase;
  draft: string;
  storyZh: string;
  messages: DailyMessage[];
  pendingTranscript: PendingTurn | null;
  review: DailyReview | null;
  revision: number | null;
  settingsRevision: number;
  operation: { id: string; settingsRevision: number } | null;
  error: { message: string; resumePhase: StablePhase } | null;
  readAloudTranscript: string | null;
  readAloudTarget: string | null;
};

export const initialDailyState: DailyState = {
  phase: "loading",
  draft: "",
  storyZh: "",
  messages: [],
  pendingTranscript: null,
  review: null,
  revision: null,
  settingsRevision: 0,
  operation: null,
  error: null,
  readAloudTranscript: null,
  readAloudTarget: null,
};

type Operation = { operationId: string; settingsRevision: number };

export type DailyAction =
  | { type: "ready"; session: StorySession | null; settingsRevision: number }
  | { type: "persisted"; session: StorySession }
  | { type: "settingsRevisionChanged"; settingsRevision: number }
  | { type: "draft"; draft: string }
  | ({ type: "startRequest"; storyZh: string } & Operation)
  | ({ type: "startSuccess"; opening: DailyMessage } & Operation)
  | { type: "recording" }
  | { type: "recordingCancelled" }
  | ({ type: "transcribeRequest"; readAloud?: boolean } & Operation)
  | ({ type: "transcribeSuccess"; transcript: PendingTurn; readAloud?: boolean } & Operation)
  | ({ type: "sendRequest"; turn: PendingTurn } & Operation)
  | ({ type: "replySuccess"; turn: PendingTurn; assistant: DailyMessage } & Operation)
  | ({ type: "reviewRequest" } & Operation)
  | ({ type: "reviewSuccess"; review: DailyReview } & Operation)
  | { type: "readAloudRecording"; target: string }
  | { type: "resetReadAloud" }
  | { type: "reRecord" }
  | { type: "newStory" }
  | ({ type: "failure"; message: string; resumePhase: StablePhase } & Partial<Operation>)
  | { type: "retry" };

function sameOperation(state: DailyState, action: Operation) {
  return (
    state.operation?.id === action.operationId &&
    state.operation.settingsRevision === action.settingsRevision &&
    state.settingsRevision === action.settingsRevision
  );
}

function stableFromSession(session: StorySession, settingsRevision: number): DailyState {
  return {
    ...initialDailyState,
    phase: session.phase,
    draft: session.storyZh,
    storyZh: session.storyZh,
    messages: session.messages,
    pendingTranscript: session.pendingAsrTranscript
      ? { ...session.pendingAsrTranscript, source: "asr" }
      : null,
    review: session.review ?? null,
    revision: session.revision,
    settingsRevision,
  };
}

export function dailyReducer(state: DailyState, action: DailyAction): DailyState {
  switch (action.type) {
    case "ready":
      return action.session
        ? stableFromSession(action.session, action.settingsRevision)
        : { ...initialDailyState, phase: "compose", settingsRevision: action.settingsRevision };
    case "persisted":
      return state.phase === action.session.phase && state.storyZh === action.session.storyZh
        ? { ...state, revision: action.session.revision }
        : state;
    case "settingsRevisionChanged": {
      if (action.settingsRevision <= state.settingsRevision) return state;
      const base = { ...state, settingsRevision: action.settingsRevision, operation: null };
      if (!state.operation) return base;
      if (state.phase === "starting") return { ...base, phase: "compose" };
      if (state.phase === "transcribing") return { ...base, phase: "chatting" };
      if (state.phase === "waitingForAi")
        return {
          ...base,
          phase: state.pendingTranscript?.source === "asr" ? "transcriptReady" : "chatting",
        };
      if (state.phase === "reviewing") return { ...base, phase: "chatting" };
      if (state.phase === "readingAloudTranscribing") return { ...base, phase: "review" };
      return base;
    }
    case "draft":
      return state.phase === "compose" ? { ...state, draft: action.draft } : state;
    case "startRequest":
      return state.phase === "compose" || state.phase === "error"
        ? {
            ...state,
            phase: "starting",
            storyZh: action.storyZh,
            draft: action.storyZh,
            settingsRevision: action.settingsRevision,
            operation: { id: action.operationId, settingsRevision: action.settingsRevision },
            error: null,
          }
        : state;
    case "startSuccess":
      return sameOperation(state, action)
        ? { ...state, phase: "chatting", messages: [action.opening], operation: null, error: null }
        : state;
    case "recording":
      return state.phase === "chatting" ? { ...state, phase: "recording", error: null } : state;
    case "recordingCancelled":
      return state.phase === "recording" ? { ...state, phase: "chatting", error: null } : state;
    case "transcribeRequest":
      if (action.readAloud) {
        return state.phase === "readingAloudRecording"
          ? {
              ...state,
              phase: "readingAloudTranscribing",
              settingsRevision: action.settingsRevision,
              operation: { id: action.operationId, settingsRevision: action.settingsRevision },
            }
          : state;
      }
      return state.phase === "recording" || state.phase === "error"
        ? {
            ...state,
            phase: "transcribing",
            settingsRevision: action.settingsRevision,
            operation: { id: action.operationId, settingsRevision: action.settingsRevision },
          }
        : state;
    case "transcribeSuccess":
      if (!sameOperation(state, action)) return state;
      if (action.readAloud) {
        return {
          ...state,
          phase: "review",
          operation: null,
          readAloudTranscript: action.transcript.text,
        };
      }
      return {
        ...state,
        phase: "transcriptReady",
        pendingTranscript: action.transcript,
        operation: null,
      };
    case "sendRequest":
      return state.phase === "transcriptReady" ||
        state.phase === "chatting" ||
        state.phase === "error"
        ? {
            ...state,
            phase: "waitingForAi",
            pendingTranscript: action.turn,
            settingsRevision: action.settingsRevision,
            operation: { id: action.operationId, settingsRevision: action.settingsRevision },
          }
        : state;
    case "replySuccess":
      return sameOperation(state, action)
        ? {
            ...state,
            phase: "chatting",
            messages: [...state.messages, { ...action.turn, role: "user" }, action.assistant],
            pendingTranscript: null,
            operation: null,
            error: null,
          }
        : state;
    case "reviewRequest":
      return state.phase === "chatting" || state.phase === "error"
        ? {
            ...state,
            phase: "reviewing",
            settingsRevision: action.settingsRevision,
            operation: { id: action.operationId, settingsRevision: action.settingsRevision },
          }
        : state;
    case "reviewSuccess":
      return sameOperation(state, action)
        ? { ...state, phase: "review", review: action.review, operation: null, error: null }
        : state;
    case "readAloudRecording":
      return state.phase === "review"
        ? {
            ...state,
            phase: "readingAloudRecording",
            readAloudTranscript: null,
            readAloudTarget: action.target,
          }
        : state;
    case "resetReadAloud":
      return state.phase === "readingAloudRecording" || state.phase === "readingAloudTranscribing"
        ? { ...state, phase: "review", operation: null }
        : state;
    case "reRecord":
      return state.phase === "transcriptReady"
        ? { ...state, phase: "chatting", pendingTranscript: null, error: null }
        : state;
    case "newStory":
      return { ...initialDailyState, phase: "compose" };
    case "failure": {
      if (action.operationId && !sameOperation(state, action as Operation)) return state;
      return {
        ...state,
        phase: "error",
        operation: null,
        error: { message: action.message, resumePhase: action.resumePhase },
      };
    }
    case "retry":
      return state.phase === "error" && state.error
        ? { ...state, phase: state.error.resumePhase, error: null }
        : state;
    default:
      return state;
  }
}

export function isDailyBusy(phase: DailyPhase) {
  return [
    "starting",
    "recording",
    "transcribing",
    "waitingForAi",
    "reviewing",
    "readingAloudRecording",
    "readingAloudTranscribing",
  ].includes(phase);
}

/** Strip every unstable/secrets-bearing field before IndexedDB persistence. */
export function snapshotDailyState(
  state: DailyState,
): Omit<StorySession, "schemaVersion" | "revision" | "updatedAt"> | null {
  if (state.phase !== "chatting" && state.phase !== "transcriptReady" && state.phase !== "review")
    return null;
  if (!state.storyZh) return null;
  return {
    phase: state.phase,
    storyZh: state.storyZh,
    messages: state.messages,
    ...(state.pendingTranscript
      ? {
          pendingAsrTranscript: {
            id: state.pendingTranscript.id,
            text: state.pendingTranscript.text,
          },
        }
      : {}),
    ...(state.review ? { review: state.review } : {}),
  };
}
