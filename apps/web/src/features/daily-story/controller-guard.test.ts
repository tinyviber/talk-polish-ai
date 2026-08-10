import { describe, expect, test } from "vitest";
import { isDailyStoryCachedAudioRetryCurrent } from "./controller";

describe("Daily Story cached audio retry guard", () => {
  test("allows a retry while the mounted generation is still current", () => {
    expect(isDailyStoryCachedAudioRetryCurrent(true, 4, 4)).toBe(true);
  });

  test("stops an IndexedDB continuation after unmount", () => {
    expect(isDailyStoryCachedAudioRetryCurrent(false, 4, 4)).toBe(false);
  });

  test("stops an IndexedDB continuation after a newer operation invalidates it", () => {
    expect(isDailyStoryCachedAudioRetryCurrent(true, 4, 5)).toBe(false);
  });
});
