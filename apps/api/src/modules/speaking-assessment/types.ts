import type { Feedback, Lang, Prompt } from "@kotoba/contracts";
import type { SpeechMetrics } from "../../capabilities/speech-metrics";

export type SpeakingAssessmentInput = {
  transcript: string;
  prompt: Prompt;
  lang: Lang;
  attemptIndex: 1 | 2;
  durationSec: number;
  metrics?: SpeechMetrics;
};

export type SpeakingAssessmentResult = {
  feedback: Feedback;
  provider: string;
  repaired?: boolean;
};
