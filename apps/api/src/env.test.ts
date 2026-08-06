import { afterEach, describe, expect, test } from "bun:test";
import { assertProductionSecret, env, resetEnvForTests } from "./env";

const initialMaxUploadBytes = process.env.MAX_UPLOAD_BYTES;
const initialS3MaxObjectBytes = process.env.S3_MAX_OBJECT_BYTES;

afterEach(() => {
  restoreEnv("MAX_UPLOAD_BYTES", initialMaxUploadBytes);
  restoreEnv("S3_MAX_OBJECT_BYTES", initialS3MaxObjectBytes);
  resetEnvForTests();
});

function restoreEnv(name: "MAX_UPLOAD_BYTES" | "S3_MAX_OBJECT_BYTES", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("production configuration safety", () => {
  test("rejects default and placeholder token secrets", () => {
    expect(() => assertProductionSecret("local-development-anon-token-secret")).toThrow();
    expect(() => assertProductionSecret("replace-with-a-long-random-secret")).toThrow();
    expect(() => assertProductionSecret("short")).toThrow();
  });

  test("accepts a sufficiently long non-placeholder secret", () => {
    expect(() =>
      assertProductionSecret("8f67b0b8aee44a2c9f2ac3b1f8cb879c4b7fe0bd0e1d5a92"),
    ).not.toThrow();
  });
});

describe("upload size configuration", () => {
  test("defaults the S3 object limit to MAX_UPLOAD_BYTES", () => {
    process.env.MAX_UPLOAD_BYTES = String(40 * 1024 * 1024);
    delete process.env.S3_MAX_OBJECT_BYTES;
    resetEnvForTests();

    expect(env().S3_MAX_OBJECT_BYTES).toBe(40 * 1024 * 1024);
  });

  test("allows an explicit, stricter S3 object limit", () => {
    process.env.MAX_UPLOAD_BYTES = String(40 * 1024 * 1024);
    process.env.S3_MAX_OBJECT_BYTES = String(8 * 1024 * 1024);
    resetEnvForTests();

    expect(env().MAX_UPLOAD_BYTES).toBe(40 * 1024 * 1024);
    expect(env().S3_MAX_OBJECT_BYTES).toBe(8 * 1024 * 1024);
  });
});
