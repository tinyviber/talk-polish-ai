import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const root = new URL(".", import.meta.url);

async function source(path: string) {
  const value = await readFile(new URL(path, root), "utf8");
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("architecture boundaries", () => {
  test("generic text and speech adapters stay product-neutral", async () => {
    const [text, asr, tts] = await Promise.all([
      source("capabilities/text-model.ts"),
      source("providers/openai-speech-to-text.ts"),
      source("providers/openai-text-to-speech.ts"),
    ]);
    expect(text).not.toMatch(/modules|Feedback|Prompt|Lang/);
    expect(asr).not.toMatch(/AudioStorageProvider|storageKey|promptId|attemptIndex/);
    expect(tts).not.toMatch(/AudioStorageProvider|cache|storageKey|learnerId|purpose/);
  });

  test("structured generation owns parsing, not text transport", async () => {
    const [adapter, generator] = await Promise.all([
      source("providers/openai-text-model.ts"),
      source("capabilities/structured-generator.ts"),
    ]);
    expect(adapter).not.toMatch(/StructuredGenerator|feedbackSchema|Prompt/);
    expect(generator).toMatch(/JSON\.parse|schema\.parse/);
  });
});
