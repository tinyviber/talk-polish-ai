import { describe, expect, test } from "bun:test";
import { PROMPTS, feedbackSchema } from "@kotoba/contracts";
import { createLocalAudioStorage } from "./local-storage";
import { createMockAssessmentProvider } from "./mock/assessment";
import { createMockTranscriptionProvider } from "./mock/transcription";
import { createMockTtsProvider } from "./mock/tts";

describe("mock provider contracts", () => {
  test("runs without credentials and returns shared shapes", async () => {
    const prompt = PROMPTS[0]!;
    const transcription = await createMockTranscriptionProvider().transcribe({
      lang: prompt.lang,
      promptId: prompt.id,
      attemptIndex: 1,
      durationSec: 5,
      audio: null,
    });
    const assessment = await createMockAssessmentProvider().assess({
      transcript: transcription.text,
      prompt,
      lang: prompt.lang,
      attemptIndex: 1,
      durationSec: 5,
    });
    expect(feedbackSchema.safeParse(assessment.feedback).success).toBe(true);
    expect(
      (await createMockTtsProvider().synthesize({ text: "hello", lang: "en" })).storageKey,
    ).toBeNull();
  });

  test("local storage rejects traversal and preserves bytes", async () => {
    const storage = createLocalAudioStorage("./data-test-provider");
    await expect(
      storage.put({ key: "../outside", body: Buffer.from("x"), contentType: "audio/webm" }),
    ).rejects.toThrow("invalid storage key");
  });
});
