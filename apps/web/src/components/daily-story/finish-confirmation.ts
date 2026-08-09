export type FinishConfirmationState = {
  open: boolean;
  submitting: boolean;
};

export type FinishConfirmationAction =
  { type: "open" } | { type: "cancel" } | { type: "confirm" } | { type: "settled" };

export const initialFinishConfirmationState: FinishConfirmationState = {
  open: false,
  submitting: false,
};

export function finishConfirmationReducer(
  state: FinishConfirmationState,
  action: FinishConfirmationAction,
): FinishConfirmationState {
  switch (action.type) {
    case "open":
      return state.submitting ? state : { open: true, submitting: false };
    case "cancel":
      return state.submitting ? state : initialFinishConfirmationState;
    case "confirm":
      return state.open && !state.submitting ? { open: false, submitting: true } : state;
    case "settled":
      return initialFinishConfirmationState;
    default:
      return state;
  }
}
