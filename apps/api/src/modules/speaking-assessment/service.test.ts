import { describe, expect, test } from "bun:test";
import { fixtureFeedback, PROMPTS } from "@kotoba/contracts";
import type {
  StructuredGenerationInput,
  StructuredGenerator,
} from "../../capabilities/structured-generator";
import { createSpeakingAssessmentService } from "./service";

describe("speaking assessment", () => {
  test("keeps language behavior and objective metrics in speaking module", async () => {
    const calls: StructuredGenerationInput<unknown>[] = [];
    const generator: StructuredGenerator = {
      async generate<T>(input: StructuredGenerationInput<T>) {
        calls.push(input as StructuredGenerationInput<unknown>);
        return {
          value: fixtureFeedback("en-smalltalk", "en", 1) as T,
          provider: "fake-text-model",
          repaired: false,
        };
      },
    };
    const service = createSpeakingAssessmentService(generator);

    const english = await service.assess({
      prompt: PROMPTS[0]!,
      transcript: "Um, I went home.",
      lang: "en",
      attemptIndex: 1,
      durationSec: 10,
      metrics: {
        status: "degraded",
        source: "transcript",
        words: 4,
        fillers: 1,
      },
    });
    const japanese = await service.assess({
      prompt: PROMPTS[4]!,
      transcript: "週末は映画を見ました。",
      lang: "ja",
      attemptIndex: 2,
      durationSec: 10,
    });

    expect(english.feedback.scores.pronunciation).toBeNull();
    expect(english.feedback.stats.words).toBe(4);
    expect(english.feedback.stats.fillers).toBe(1);
    expect(english.feedback.pronunciationSource).toBe("unavailable");
    expect(calls[0]?.messages[0]?.content).toContain("English behavior");
    expect(calls[1]?.messages[0]?.content).toContain("Japanese behavior");
    expect(calls[1]?.messages[0]?.content).toContain("Second attempt");
    expect(calls[0]?.messages[1]?.content).toContain("requiredOutputShape");
    expect(japanese.feedback.scores.pronunciation).toBeNull();
  });
});
