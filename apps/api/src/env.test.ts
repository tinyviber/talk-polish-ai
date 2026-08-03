import { describe, expect, test } from "bun:test";
import { assertProductionSecret } from "./env";

describe("production configuration safety", () => {
  test("rejects default and placeholder token secrets", () => {
    expect(() => assertProductionSecret("local-development-anon-token-secret")).toThrow();
    expect(() => assertProductionSecret("replace-with-a-long-random-secret")).toThrow();
    expect(() => assertProductionSecret("short")).toThrow();
  });

  test("accepts a sufficiently long non-placeholder secret", () => {
    expect(() => assertProductionSecret("8f67b0b8aee44a2c9f2ac3b1f8cb879c4b7fe0bd0e1d5a92")).not.toThrow();
  });
});
