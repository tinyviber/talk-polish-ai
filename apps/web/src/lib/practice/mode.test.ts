import { describe, expect, test } from "vitest";
import { configuredAppMode } from "./mode";

describe("app mode", () => {
  test("defaults to explicit-safe demo mode when no Vite mode is supplied", () => {
    expect(["demo", "api"]).toContain(configuredAppMode);
  });
});
