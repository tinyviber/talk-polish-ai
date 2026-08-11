import { describe, expect, test, vi } from "vitest";
import { runSingleFlight } from "./single-flight";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Daily Story single flight", () => {
  test("shares one in-flight transcription submission", async () => {
    const deferred = createDeferred<string>();
    const task = vi.fn(() => deferred.promise);
    const ref: { current: Promise<string> | null } = { current: null };

    const first = runSingleFlight(ref, task);
    const second = runSingleFlight(ref, task);

    expect(first).toBe(second);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    deferred.resolve("ok");
    await expect(first).resolves.toBe("ok");
    expect(ref.current).toBeNull();
  });

  test("allows a fresh submission after the previous one settles", async () => {
    const task = vi.fn().mockResolvedValue("ok");
    const ref: { current: Promise<string> | null } = { current: null };

    await expect(runSingleFlight(ref, task)).resolves.toBe("ok");
    await expect(runSingleFlight(ref, task)).resolves.toBe("ok");

    expect(task).toHaveBeenCalledTimes(2);
  });
});
