import { describe, expect, test } from "vitest";
import { finishConfirmationReducer, initialFinishConfirmationState } from "./finish-confirmation";

describe("finish confirmation", () => {
  test("cancel closes dialog without starting review", () => {
    const open = finishConfirmationReducer(initialFinishConfirmationState, { type: "open" });

    expect(finishConfirmationReducer(open, { type: "cancel" })).toEqual(
      initialFinishConfirmationState,
    );
  });

  test("confirm enters submitting state and ignores duplicate confirmation", () => {
    const open = finishConfirmationReducer(initialFinishConfirmationState, { type: "open" });
    const submitting = finishConfirmationReducer(open, { type: "confirm" });

    expect(submitting).toEqual({ open: false, submitting: true });
    expect(finishConfirmationReducer(submitting, { type: "confirm" })).toEqual(submitting);
    expect(finishConfirmationReducer(submitting, { type: "settled" })).toEqual(
      initialFinishConfirmationState,
    );
  });
});
