import { z } from "zod";

/**
 * Server-side configuration. Provider credentials and storage paths never
 * reach the browser — the web app only knows the public API URL.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .default("postgres://kotoba:kotoba@localhost:5432/kotoba"),
  /** Comma-separated list, or `*` for local development. */
  CORS_ORIGIN: z.string().default("*"),
  /** Root directory for local development artefacts (never committed). */
  DATA_DIR: z.string().default("./data"),
  /** `local` today; `s3` once an S3-compatible provider is added. */
  AUDIO_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  TRANSCRIPTION_PROVIDER: z.enum(["mock"]).default("mock"),
  ASSESSMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  TTS_PROVIDER: z.enum(["mock"]).default("mock"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`Invalid API environment configuration:\n  ${issues.join("\n  ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}
