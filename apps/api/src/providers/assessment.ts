import type { Feedback, Lang, Prompt } from "@kotoba/contracts";
import type { SpeechMetrics } from "../capabilities/speech-metrics";

export type AssessmentInput = {
  transcript: string;
  prompt: Prompt;
  lang: Lang;
  attemptIndex: 1 | 2;
  durationSec: number;
  metrics?: SpeechMetrics;
};

export type AssessmentResult = {
  feedback: Feedback;
  provider: string;
};

export interface AssessmentProvider {
  readonly name: string;
  assess(input: AssessmentInput): Promise<AssessmentResult>;
  check?(): Promise<void>;
  probe?(): Promise<void>;
}
