import { fixtureFeedback } from "@kotoba/contracts";
import type { AssessmentInput, AssessmentProvider, AssessmentResult } from "../assessment";

/**
 * Deterministic mock speaking assessment. Replace this file with an LLM /
 * pronunciation-scoring client; the returned shape is the `Feedback` contract.
 */
export function createMockAssessmentProvider(): AssessmentProvider {
  return {
    name: "mock-assessment",
    async assess(input: AssessmentInput): Promise<AssessmentResult> {
      await new Promise((r) => setTimeout(r, 350));
      return {
        feedback: fixtureFeedback(input.prompt.id, input.lang, input.attemptIndex),
        provider: "mock-assessment",
      };
    },
  };
}
