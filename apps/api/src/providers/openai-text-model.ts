import type {
  TextModel,
  TextModelMessage,
  TextModelRequest,
  TextModelResponse,
} from "../capabilities/text-model";
import {
  createOpenAICompatibleHttpClient,
  ProviderConfigurationError,
  type OpenAICompatibleHttpClient,
} from "./http";

export type OpenAITextModelConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxAttempts: number;
};

/** OpenAI-compatible transport only. No speaking/product imports. */
export function createOpenAICompatibleTextModel(config: OpenAITextModelConfig): TextModel {
  const client = createOpenAICompatibleHttpClient({ capability: "chat", ...config });
  return {
    name: "openai-compatible-text-model",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await generateRequest(client, config, {
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 1,
      });
    },
    async generate(input) {
      requireConfigured(config);
      return generateRequest(client, config, input);
    },
  };
}

async function generateRequest(
  client: OpenAICompatibleHttpClient,
  config: OpenAITextModelConfig,
  input: TextModelRequest,
): Promise<TextModelResponse> {
  const result = await client.requestJson<unknown>({
    operation: "chat.completions",
    path: "/chat/completions",
    requestId: input.requestId,
    body: {
      model: config.model,
      messages: input.messages satisfies TextModelMessage[],
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      ...(input.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    },
  });
  const source = asRecord(result);
  const choices = Array.isArray(source?.choices) ? source.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  const content = extractContent(message?.content);
  if (!content) throw new Error("Text model response did not contain content");
  const usage = asRecord(source?.usage);
  return {
    content,
    provider: "openai-compatible",
    model: config.model,
    usage: usage
      ? {
          inputTokens: numberValue(usage.prompt_tokens ?? usage.input_tokens),
          outputTokens: numberValue(usage.completion_tokens ?? usage.output_tokens),
        }
      : undefined,
  };
}

function requireConfigured(config: OpenAITextModelConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("Chat provider configuration is incomplete");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function extractContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string"
        ? record.text
        : typeof record?.content === "string"
          ? record.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}
