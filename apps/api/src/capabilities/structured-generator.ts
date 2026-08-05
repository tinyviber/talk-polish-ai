import type { z } from "zod";
import type { TextModel, TextModelMessage } from "./text-model";

export class StructuredGenerationError extends Error {
  readonly code = "structured_generation";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type StructuredGenerationInput<T> = {
  messages: TextModelMessage[];
  schema: z.ZodType<T>;
  repairInstruction?: string;
  requestId?: string;
  maxTokens?: number;
};

export interface StructuredGenerator {
  generate<T>(input: StructuredGenerationInput<T>): Promise<{
    value: T;
    provider: string;
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    repaired: boolean;
  }>;
}

/** Generic JSON extraction, validation, and one bounded repair attempt. */
export function createStructuredGenerator(model: TextModel): StructuredGenerator {
  return {
    async generate<T>(input: StructuredGenerationInput<T>) {
      const first = await model.generate({
        messages: input.messages,
        responseFormat: "json",
        maxTokens: input.maxTokens,
        requestId: input.requestId,
      });
      const parsed = parseCandidate(first.content, input.schema);
      if (parsed.success) return { ...first, value: parsed.value, repaired: false };

      const repair = await model.generate({
        messages: [
          ...input.messages,
          {
            role: "user",
            content: [
              input.repairInstruction ?? "Return only valid JSON matching the requested schema.",
              `Invalid model output:\n${first.content.slice(0, 16_000)}`,
            ].join("\n"),
          },
        ],
        responseFormat: "json",
        maxTokens: input.maxTokens,
        requestId: input.requestId,
      });
      const repaired = parseCandidate(repair.content, input.schema);
      if (!repaired.success) {
        throw new StructuredGenerationError("Structured model output failed schema validation.", {
          first: parsed.error,
          repair: repaired.error,
        });
      }
      return { ...repair, value: repaired.value, repaired: true };
    },
  };
}

function parseCandidate<T>(content: string, schema: z.ZodType<T>) {
  const candidate = stripJsonFence(content);
  try {
    return { success: true as const, value: schema.parse(JSON.parse(candidate)) };
  } catch (error) {
    return { success: false as const, error };
  }
}

export function stripJsonFence(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}
