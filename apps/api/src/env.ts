import { z } from "zod";

/**
 * Server-side configuration. Provider credentials and storage paths never
 * reach the browser — the web app only knows the public API URL.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.string().min(1).default("0.1.0"),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default("0.0.0.0"),
  /** Enable only when a trusted reverse proxy overwrites forwarding headers. */
  TRUST_PROXY: envBoolean(false),
  DATABASE_URL: z.string().default("postgres://kotoba:kotoba@localhost:5432/kotoba"),
  /** Comma-separated list, or `*` for local development. */
  CORS_ORIGIN: z.string().default("*"),
  /** HMAC key used to sign anonymous learner bearer tokens. Change in deployment. */
  ANON_TOKEN_SECRET: z.string().min(16).default("local-development-anon-token-secret"),
  ANON_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),
  /** Root directory for local development artefacts (never committed). */
  DATA_DIR: z.string().default("./data"),
  /** `local` for development, `s3` for MinIO/R2. */
  AUDIO_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  TRANSCRIPTION_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  ASSESSMENT_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  TTS_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  CHAT_BASE_URL: optionalString(),
  CHAT_API_KEY: optionalString(),
  CHAT_MODEL: optionalString(),
  CHAT_TIMEOUT_MS: positiveInt(30_000),
  TRANSCRIPTION_BASE_URL: optionalString(),
  TRANSCRIPTION_API_KEY: optionalString(),
  TRANSCRIPTION_MODEL: optionalString(),
  TRANSCRIPTION_TIMEOUT_MS: positiveInt(60_000),
  /** Some OpenAI-compatible servers only implement `json`. */
  TRANSCRIPTION_RESPONSE_FORMAT: z.enum(["json", "verbose_json"]).default("verbose_json"),
  TTS_BASE_URL: optionalString(),
  TTS_API_KEY: optionalString(),
  TTS_MODEL: optionalString(),
  TTS_VOICE: z.string().default("alloy"),
  TTS_TIMEOUT_MS: positiveInt(30_000),
  HTTP_MAX_ATTEMPTS: positiveInt(3),
  PROVIDER_RATE_LIMIT_PER_MINUTE: positiveInt(20),
  /** Daily Story limits are intentionally separate from legacy provider routes. */
  DAILY_STORY_RATE_LIMIT_PER_MINUTE: positiveInt(12),
  DAILY_STORY_PROVIDER_CHECK_RATE_LIMIT_PER_MINUTE: positiveInt(3),
  DAILY_STORY_CONCURRENT_REQUESTS: positiveInt(2),
  /**
   * Server-owned finite production origin allowlist for browser-supplied Daily
   * provider URLs. Dynamic origins stay disabled until a Bun transport proof is
   * shipped as a release gate.
   */
  DAILY_PROVIDER_ALLOWED_ORIGINS: z
    .string()
    .default("https://api.deepseek.com,https://api.siliconflow.cn"),
  S3_ENDPOINT: optionalString().default("http://127.0.0.1:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("kotoba-audio"),
  S3_ACCESS_KEY_ID: optionalString(),
  S3_SECRET_ACCESS_KEY: optionalString(),
  S3_FORCE_PATH_STYLE: envBoolean(true),
  /** Allow only the Docker Compose `http://minio:9000` service in production. */
  S3_ALLOW_INSECURE_INTERNAL: envBoolean(false),
  S3_REQUEST_TIMEOUT_MS: positiveInt(10_000),
  S3_MAX_ATTEMPTS: positiveInt(3),
  /** Defaults to MAX_UPLOAD_BYTES; set explicitly to enforce a stricter S3 limit. */
  S3_MAX_OBJECT_BYTES: positiveInt(25 * 1024 * 1024),
  S3_KEY_PREFIX: z.string().default(""),
  REALTIME_FEATURE_ENABLED: envBoolean(false),
  REALTIME_URL: optionalString(),
  REALTIME_API_KEY: optionalString(),
  REALTIME_PROTOCOL: z.enum(["websocket", "webrtc-unified"]).default("websocket"),
  REALTIME_MODEL: optionalString(),
  REALTIME_TIMEOUT_MS: positiveInt(15_000),
  DIAGNOSTICS_ACTIVE_PROBE: envBoolean(false),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const rawEnv: Record<string, string | undefined> = {
      ...process.env,
      APP_VERSION: process.env.APP_VERSION ?? process.env.npm_package_version ?? "0.1.0",
    };
    const parsed = envSchema.safeParse({
      ...rawEnv,
      // Keep S3 reads aligned with the upload boundary unless explicitly overridden.
      S3_MAX_OBJECT_BYTES: rawEnv.S3_MAX_OBJECT_BYTES ?? rawEnv.MAX_UPLOAD_BYTES,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`Invalid API environment configuration:\n  ${issues.join("\n  ")}`);
    }
    if (
      parsed.data.NODE_ENV === "production" &&
      parsed.data.ANON_TOKEN_SECRET === "local-development-anon-token-secret"
    ) {
      throw new Error("ANON_TOKEN_SECRET must be changed in production.");
    }
    if (parsed.data.NODE_ENV === "production") {
      assertProductionSecret(parsed.data.ANON_TOKEN_SECRET);
    }
    if (parsed.data.NODE_ENV === "production" && parsed.data.CORS_ORIGIN === "*") {
      throw new Error("CORS_ORIGIN must be explicit in production.");
    }
    if (parsed.data.NODE_ENV === "production") {
      if (parsed.data.AUDIO_STORAGE_DRIVER !== "s3") {
        throw new Error("AUDIO_STORAGE_DRIVER=s3 is required in production.");
      }
      if (parsed.data.DATABASE_URL === "postgres://kotoba:kotoba@localhost:5432/kotoba") {
        throw new Error("DATABASE_URL must be explicit in production.");
      }
      if (
        parsed.data.S3_ACCESS_KEY_ID === "minioadmin" ||
        parsed.data.S3_SECRET_ACCESS_KEY === "minioadmin"
      ) {
        throw new Error("Development S3 credentials are not allowed in production.");
      }
    }
    for (const [name, value] of [
      ["CHAT_BASE_URL", parsed.data.CHAT_BASE_URL],
      ["TRANSCRIPTION_BASE_URL", parsed.data.TRANSCRIPTION_BASE_URL],
      ["TTS_BASE_URL", parsed.data.TTS_BASE_URL],
    ] as const) {
      if (value) assertProviderUrl(name, value, parsed.data.NODE_ENV === "production");
    }
    if (parsed.data.AUDIO_STORAGE_DRIVER === "s3" && parsed.data.S3_ENDPOINT) {
      assertS3Endpoint(
        parsed.data.S3_ENDPOINT,
        parsed.data.NODE_ENV === "production",
        parsed.data.S3_ALLOW_INSECURE_INTERNAL,
      );
    }
    if (parsed.data.REALTIME_URL) {
      assertRealtimeUrl(parsed.data.REALTIME_URL, parsed.data.NODE_ENV === "production");
    }
    if (parsed.data.REALTIME_FEATURE_ENABLED) {
      const missing = [
        ["REALTIME_URL", parsed.data.REALTIME_URL],
        ["REALTIME_API_KEY", parsed.data.REALTIME_API_KEY],
        ["REALTIME_MODEL", parsed.data.REALTIME_MODEL],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(`Realtime configuration is incomplete: ${missing.join(", ")}`);
      }
      if (parsed.data.REALTIME_PROTOCOL !== "websocket") {
        throw new Error("Only REALTIME_PROTOCOL=websocket is implemented in this release.");
      }
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test-only seam for processes that deliberately change configuration before boot. */
export function resetEnvForTests() {
  cached = undefined;
}

export function assertProductionSecret(secret: string) {
  if (
    secret.length < 32 ||
    /(?:replace[-_ ]?with|change[-_ ]?me|example|local-development|test-secret)/i.test(secret)
  ) {
    throw new Error(
      "ANON_TOKEN_SECRET must be a unique random secret of at least 32 characters in production.",
    );
  }
}

function assertProviderUrl(name: string, value: string, production: boolean) {
  const parsed = parseHttpUrl(name, value);
  if (production && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production.`);
  }
}

function assertS3Endpoint(value: string, production: boolean, allowInsecureInternal: boolean) {
  const parsed = parseHttpUrl("S3_ENDPOINT", value);
  if (!production || parsed.protocol === "https:") return;
  if (
    allowInsecureInternal &&
    parsed.protocol === "http:" &&
    parsed.hostname === "minio" &&
    parsed.port === "9000" &&
    parsed.pathname === "/" &&
    !parsed.search &&
    !parsed.hash
  ) {
    return;
  }
  throw new Error(
    "S3_ENDPOINT must use HTTPS in production unless it is the Docker-internal http://minio:9000 endpoint with S3_ALLOW_INSECURE_INTERNAL=true.",
  );
}

function parseHttpUrl(name: string, value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials.`);
  }
  return parsed;
}

function assertRealtimeUrl(value: string, production: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REALTIME_URL must be a valid WebSocket URL.");
  }
  if (!["ws:", "wss:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("REALTIME_URL must use ws:// or wss:// without embedded credentials.");
  }
  if (production && parsed.protocol !== "wss:") {
    throw new Error("REALTIME_URL must use WSS in production.");
  }
}

function optionalString() {
  return z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
}

function positiveInt(defaultValue: number) {
  return z.coerce.number().int().positive().default(defaultValue);
}

function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (value === true || value === false) return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  }, z.boolean());
}
