import { createStructuredGenerator } from "../capabilities/structured-generator";
import { createSpeakingAssessmentService } from "../modules/speaking-assessment/service";
import type { AssessmentInput, AssessmentProvider, AssessmentResult } from "./assessment";
import { ProviderRequestError } from "./http";
import { createOpenAICompatibleTextModel, type OpenAITextModelConfig } from "./openai-text-model";
import type { StructuredGenerator } from "../capabilities/structured-generator";
import type { TextModel } from "../capabilities/text-model";

export type OpenAIAssessmentConfig = OpenAITextModelConfig;

/** Compatibility facade. Speaking policy lives in `modules/speaking-assessment`. */
export function createOpenAICompatibleAssessmentProvider(
  config: OpenAIAssessmentConfig,
  dependencies: { model?: TextModel; generator?: StructuredGenerator } = {},
): AssessmentProvider {
  const model = dependencies.model ?? createOpenAICompatibleTextModel(config);
  const generator = dependencies.generator ?? createStructuredGenerator(model);
  const service = createSpeakingAssessmentService(generator);
  return {
    name: "openai-compatible-chat",
    check: model.check,
    probe: model.probe,
    async assess(input: AssessmentInput): Promise<AssessmentResult> {
      try {
        return await service.assess(input);
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        throw new ProviderRequestError("Chat response was not valid feedback JSON.", {
          code: "response",
          retryCount: 1,
        });
      }
    },
  };
}
