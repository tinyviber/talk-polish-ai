import { feedbackSchema, type Feedback } from "@kotoba/contracts";
import type { StructuredGenerator } from "../../capabilities/structured-generator";
import { computeSpeechMetrics, type SpeechMetrics } from "../../capabilities/speech-metrics";
import { attemptBehavior, speakingBehavior } from "./behavior";
import { englishSpeakingSystemPrompt } from "./templates/english";
import { japaneseSpeakingSystemPrompt } from "./templates/japanese";
import type { SpeakingAssessmentInput, SpeakingAssessmentResult } from "./types";

const feedbackOutputShape = {
  overall: "integer 0..100",
  headline: "string",
  scores: {
    fluency: "integer 0..100",
    pauses: "integer 0..100",
    grammar: "integer 0..100",
    vocabulary: "integer 0..100",
    naturalness: "integer 0..100",
    pronunciation: "null unless an acoustic scorer is supplied",
  },
  improvements: [{ title: "string", detail: "string", before: "string", after: "string" }],
  annotations: [{ text: "string", kind: "ok|grammar|filler|word", note: "optional string" }],
  expressions: [
    { id: "string", lang: "en|ja", text: "string", reading: "optional string", meaning: "string" },
  ],
  stats: { words: "number", wpm: "number", fillers: "number", longestPause: "string" },
};

export function createSpeakingAssessmentService(generator: StructuredGenerator) {
  return {
    async assess(input: SpeakingAssessmentInput): Promise<SpeakingAssessmentResult> {
      const metrics =
        input.metrics ??
        computeSpeechMetrics({
          text: input.transcript,
          locale: input.lang === "ja" ? "ja-JP" : "en-US",
          durationSec: input.durationSec,
        });
      const generated = await generator.generate({
        schema: feedbackSchema,
        messages: [
          {
            role: "system",
            content:
              (input.lang === "ja" ? japaneseSpeakingSystemPrompt : englishSpeakingSystemPrompt) +
              ` ${speakingBehavior(input.lang)} ${attemptBehavior(input.attemptIndex)} ` +
              "Never invent pronunciation, pause, WPM, word timing, or filler measurements. Pronunciation is unavailable unless an acoustic scorer is explicitly supplied.",
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt: input.prompt,
              transcript: input.transcript,
              attemptIndex: input.attemptIndex,
              measuredSpeechMetrics: metrics,
              requiredOutputShape: feedbackOutputShape,
              outputRules: {
                pronunciation: null,
                stats: "Use measuredSpeechMetrics exactly; do not estimate missing values.",
              },
            }),
          },
        ],
        repairInstruction:
          "Repair JSON shape only. Keep pronunciation null and never invent audio measurements.",
      });
      return {
        feedback: assembleFeedback(generated.value, metrics),
        provider: generated.provider,
        repaired: generated.repaired,
      };
    },
  };
}

function assembleFeedback(feedback: Feedback, metrics: SpeechMetrics): Feedback {
  return {
    ...feedback,
    scores: { ...feedback.scores, pronunciation: null },
    pronunciationStatus: "unavailable",
    pronunciationSource: "unavailable",
    sources: {
      overall: "derived",
      text: "text-model",
      speechMetrics: "speech-metrics",
      pronunciation: "unavailable",
    },
    speechMetricsStatus: metrics.status,
    speechMetricsSource: metrics.source === "unavailable" ? undefined : metrics.source,
    stats: {
      ...feedback.stats,
      words: metrics.words ?? 0,
      wpm: metrics.wpm ?? 0,
      fillers: metrics.fillers ?? 0,
      longestPause:
        metrics.longestPauseSec === undefined
          ? "Unavailable"
          : `${metrics.longestPauseSec.toFixed(1)}s`,
    },
  };
}

export function createMockSpeakingAssessment() {
  return {
    async assess(input: SpeakingAssessmentInput): Promise<SpeakingAssessmentResult> {
      const { fixtureFeedback } = await import("@kotoba/contracts");
      return {
        feedback: fixtureFeedback(input.prompt.id, input.lang, input.attemptIndex),
        provider: "mock-assessment",
      };
    },
  };
}
