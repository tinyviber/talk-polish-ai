import { describe, expect, test } from "vitest";
import { createOperationGuard, createSequenceGate } from "./operation-guards";

describe("Daily Story operation guard", () => {
  test("marks only the latest operation current within a generation", () => {
    const guard = createOperationGuard();
    const first = guard.begin(3);
    const second = guard.begin(3);

    expect(first).toEqual({ generation: 0, id: 1, settingsRevision: 3 });
    expect(second).toEqual({ generation: 0, id: 2, settingsRevision: 3 });
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  test("invalidates an operation by advancing the generation", () => {
    const guard = createOperationGuard();
    const oldToken = guard.begin(4);

    guard.invalidate();

    expect(guard.generation()).toBe(1);
    expect(guard.isCurrent(oldToken)).toBe(false);

    const newToken = guard.begin(4);
    expect(newToken.generation).toBe(1);
    expect(guard.isCurrent(newToken)).toBe(true);
  });

  test("requires the settings revision captured by the operation", () => {
    const guard = createOperationGuard();
    const token = guard.begin(7);

    expect(guard.isCurrent({ ...token, settingsRevision: 8 })).toBe(false);
    expect(guard.isCurrent({ ...token })).toBe(true);
  });
});

describe("Daily Story sequence gate", () => {
  test.each(["load", "persistence", "event"])("keeps only the latest %s sequence current", () => {
    const gate = createSequenceGate();
    const first = gate.begin();
    const latest = gate.begin();

    expect(first).toBe(1);
    expect(latest).toBe(2);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(latest)).toBe(true);
  });
});
