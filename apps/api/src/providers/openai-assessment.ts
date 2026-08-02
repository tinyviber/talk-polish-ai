import { feedbackSchema, type Feedback } from "@kotoba/contracts";
import {
  createOpenAICompatibleHttpClient,
  ProviderConfigurationError,
  ProviderRequestError,
} from "./http";
import type { AssessmentInput, AssessmentProvider, AssessmentResult } from "./assessment";

export type OpenAIAssessmentConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxAttempts: number;
};

export function createOpenAICompatibleAssessmentProvider(
  config: OpenAIAssessmentConfig,
): AssessmentProvider {
  const client = createOpenAICompatibleHttpClient({ capability: "chat", ...config });
  return {
    name: "openai-compatible-chat",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await client.requestJson({
        operation: "chat.completions.probe",
        path: "/chat/completions",
        body: {
          model: config.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "Reply with OK." }],
        },
      });
    },
    async assess(input: AssessmentInput): Promise<AssessmentResult> {
      requireConfigured(config);
      const content = await requestFeedback(client, config.model!, input, false);
      let feedback = parseFeedback(content);
      if (!feedback) {
        const repaired = await requestFeedback(client, config.model!, input, true, content);
        feedback = parseFeedback(repaired);
      }
      if (!feedback) {
        throw new ProviderRequestError("Chat response was not valid feedback JSON.", {
          code: "response",
          retryCount: 1,
        });
      }
      return { feedback, provider: "openai-compatible-chat" };
    },
  };
}

function requireConfigured(config: OpenAIAssessmentConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("Chat provider configuration is incomplete");
  }
}

async function requestFeedback(
  client: ReturnType<typeof createOpenAICompatibleHttpClient>,
  model: string,
  input: AssessmentInput,
  repair: boolean,
  invalidContent?: string,
) {
  const system = repair
    ? "Return only valid JSON matching the required feedback schema. Repair JSON syntax only; do not add claims unsupported by the transcript."
    : "You are a speaking-practice coach. Return only valid JSON matching the required feedback schema. Do not diagnose emotion or personality. Base feedback on the prompt, language, transcript, and duration. Use empty arrays when evidence is absent.";
  const user = repair
    ? `Repair this invalid JSON into the exact schema. Invalid content:\n${invalidContent?.slice(0, 16_000) ?? ""}`
    : JSON.stringify({
        task: "Assess speaking answer",
        language: input.lang,
        prompt: {
          scenario: input.prompt.scenario,
          situation: input.prompt.situation,
          question: input.prompt.question,
          hints: input.prompt.hints,
        },
        transcript: input.transcript,
        durationSec: input.durationSec,
        attemptIndex: input.attemptIndex,
        requiredSchema: feedbackSchemaShape,
      });
  const response = await client.requestJson<unknown>({
    operation: repair ? "chat.completions.repair" : "chat.completions",
    path: "/chat/completions",
    body: {
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
  if (!response || typeof response !== "object") return "";
  const choices = "choices" in response ? response.choices : undefined;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = "message" in choices[0] ? choices[0].message : undefined;
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  return typeof message.content === "string" ? message.content : "";
}

function parseFeedback(content: string): Feedback | null {
  const candidate = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!candidate) return null;
  try {
    return feedbackSchema.parse(JSON.parse(candidate));
  } catch {
    return null;
  }
}

const feedbackSchemaShape = {
  overall: "integer 0..100",
  headline: "string",
  scores: {
    fluency: "integer 0..100",
    pauses: "integer 0..100",
    grammar: "integer 0..100",
    vocabulary: "integer 0..100",
    naturalness: "integer 0..100",
    pronunciation: "integer 0..100",
  },
  improvements: [{ title: "string", detail: "string", before: "string", after: "string" }],
  annotations: [{ text: "string", kind: "ok|grammar|filler|word", note: "optional string" }],
  expressions: [
    { id: "string", lang: "en|ja", text: "string", reading: "optional string", meaning: "string" },
  ],
  stats: { words: "number", wpm: "number", fillers: "number", longestPause: "string" },
};
