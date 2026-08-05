import { z } from "zod";

export const pronunciationStatusSchema = z.enum(["available", "unavailable"]);
export type PronunciationStatus = z.infer<typeof pronunciationStatusSchema>;

export const pronunciationSourceSchema = z.enum(["acoustic-scorer", "unavailable"]);
export type PronunciationSource = z.infer<typeof pronunciationSourceSchema>;

export const speechMetricsStatusSchema = z.enum(["available", "degraded", "unavailable"]);
export type SpeechMetricsStatus = z.infer<typeof speechMetricsStatusSchema>;

export const speechMetricsSourceSchema = z.enum([
  "timestamps",
  "transcript",
  "client-duration",
  "unavailable",
]);
export type SpeechMetricsSource = z.infer<typeof speechMetricsSourceSchema>;

export const feedbackSourceSchema = z.enum([
  "speech-metrics",
  "pronunciation-model",
  "text-model",
  "derived",
  "unavailable",
]);
export type FeedbackSource = z.infer<typeof feedbackSourceSchema>;

export const feedbackProvenanceSchema = z
  .object({
    overall: feedbackSourceSchema,
    text: feedbackSourceSchema,
    speechMetrics: feedbackSourceSchema,
    pronunciation: feedbackSourceSchema,
  })
  .partial();
export type FeedbackProvenance = z.infer<typeof feedbackProvenanceSchema>;
