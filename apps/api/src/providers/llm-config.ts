import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type LocalCapability = { models?: unknown };
type LocalConfig = {
  llm?: LocalCapability;
  transcribe?: LocalCapability;
  tts?: LocalCapability;
};

/**
 * Local-only fallback for model names. Endpoints and credentials are never
 * trusted from this file; use server environment variables for URLs and keys.
 */
export function localLlmConfig(capability: "chat" | "transcription" | "tts") {
  const candidates = [
    path.resolve(process.cwd(), "llm_config.json"),
    path.resolve(import.meta.dir, "../../../../llm_config.json"),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return {};

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LocalConfig;
    const section =
      parsed[capability === "chat" ? "llm" : capability === "transcription" ? "transcribe" : "tts"];
    const models = Array.isArray(section?.models)
      ? section.models.filter((model): model is string => typeof model === "string")
      : [];
    return { model: models[0] };
  } catch {
    return {};
  }
}
