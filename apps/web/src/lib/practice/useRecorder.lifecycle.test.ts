import { describe, expect, test } from "vitest";
import { ownsDiscardGeneration, ownsRecorderGeneration } from "./useRecorder";

describe("recorder lifecycle ownership", () => {
  test("ignores events from an old recorder after a new generation starts", () => {
    const oldRecorder = {};
    const newRecorder = {};

    expect(ownsRecorderGeneration(1, 2, oldRecorder, newRecorder)).toBe(false);
    expect(ownsRecorderGeneration(2, 2, oldRecorder, newRecorder)).toBe(false);
    expect(ownsRecorderGeneration(2, 2, newRecorder, newRecorder)).toBe(true);
  });

  test("allows cleanup only to the current reset discard owner", () => {
    expect(ownsDiscardGeneration(1, 2, 1)).toBe(false);
    expect(ownsDiscardGeneration(2, 2, 1)).toBe(false);
    expect(ownsDiscardGeneration(2, 2, 2)).toBe(true);
  });

  test("late old discard cannot consume a new recorder or its cleanup", async () => {
    const oldRecorder = {};
    const newRecorder = {};
    let currentGeneration = 1;
    let activeRecorder: object | null = oldRecorder;
    let discardOwner: number | null = 1;
    let cleanupCount = 0;
    let resolveOldDiscard!: () => void;
    const oldDiscard = new Promise<void>((resolve) => {
      resolveOldDiscard = resolve;
    });
    const finishDiscard = async (generation: number) => {
      await oldDiscard;
      if (ownsDiscardGeneration(generation, currentGeneration, discardOwner)) {
        cleanupCount += 1;
      }
    };

    const oldDiscardWork = finishDiscard(1);
    currentGeneration = 2;
    discardOwner = 2;
    activeRecorder = newRecorder;

    expect(ownsRecorderGeneration(1, currentGeneration, oldRecorder, activeRecorder)).toBe(false);
    expect(ownsRecorderGeneration(2, currentGeneration, newRecorder, activeRecorder)).toBe(true);
    resolveOldDiscard();
    await oldDiscardWork;
    expect(cleanupCount).toBe(0);

    if (ownsDiscardGeneration(2, currentGeneration, discardOwner)) cleanupCount += 1;
    expect(cleanupCount).toBe(1);
    expect(activeRecorder).toBe(newRecorder);
  });
});
