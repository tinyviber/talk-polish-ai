import { afterEach, describe, expect, test } from "bun:test";
import { assertProductionSecret, env, resetEnvForTests } from "./env";

const envKeys = [
  "MAX_UPLOAD_BYTES",
  "S3_MAX_OBJECT_BYTES",
  "NODE_ENV",
  "ANON_TOKEN_SECRET",
  "CORS_ORIGIN",
  "AUDIO_STORAGE_DRIVER",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ALLOW_INSECURE_INTERNAL",
  "CHAT_BASE_URL",
  "TRANSCRIPTION_BASE_URL",
  "TTS_BASE_URL",
  "REALTIME_FEATURE_ENABLED",
] as const;
const initialEnv = new Map(envKeys.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of initialEnv) restoreEnv(name, value);
  resetEnvForTests();
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureProduction(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    NODE_ENV: "production",
    ANON_TOKEN_SECRET: "d18b1d398c1c4795bca941a7605095035c646348158d247fe194c2924e38f4b9",
    CORS_ORIGIN: "https://app.example.test",
    AUDIO_STORAGE_DRIVER: "s3",
    DATABASE_URL: "postgres://kotoba:password@postgres:5432/kotoba",
    S3_ENDPOINT: "https://storage.example.test",
    S3_ACCESS_KEY_ID: "production-access-key",
    S3_SECRET_ACCESS_KEY: "production-secret-key",
    S3_ALLOW_INSECURE_INTERNAL: "false",
    CHAT_BASE_URL: "",
    TRANSCRIPTION_BASE_URL: "",
    TTS_BASE_URL: "",
    REALTIME_FEATURE_ENABLED: "false",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  resetEnvForTests();
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

  test("allows only flagged Docker-internal MinIO HTTP", () => {
    configureProduction({
      S3_ENDPOINT: "http://minio:9000",
      S3_ALLOW_INSECURE_INTERNAL: "true",
    });

    expect(env().S3_ENDPOINT).toBe("http://minio:9000");
  });

  test("rejects unflagged or external production S3 HTTP", () => {
    configureProduction({ S3_ENDPOINT: "http://minio:9000" });
    expect(() => env()).toThrow("S3_ENDPOINT must use HTTPS");

    configureProduction({
      S3_ENDPOINT: "http://storage.example.test",
      S3_ALLOW_INSECURE_INTERNAL: "true",
    });
    expect(() => env()).toThrow("S3_ENDPOINT must use HTTPS");
  });

  test("keeps provider URLs HTTPS-only when internal S3 HTTP is enabled", () => {
    configureProduction({
      S3_ENDPOINT: "http://minio:9000",
      S3_ALLOW_INSECURE_INTERNAL: "true",
      CHAT_BASE_URL: "http://provider.example.test",
    });

    expect(() => env()).toThrow("CHAT_BASE_URL must use HTTPS in production.");
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
