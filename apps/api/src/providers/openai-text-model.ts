import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { TextModel, TextModelRequest, TextModelResponse } from "../capabilities/text-model";
import { ProviderConfigurationError, ProviderRequestError } from "./http";

export type OpenAITextModelConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxAttempts: number;
};

type AiSdkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type AiSdkTextModelOptions = {
  fetch?: AiSdkFetch;
  name?: string;
};

/** OpenAI-compatible language model backed by Vercel AI SDK Core. */
export function createOpenAICompatibleTextModel(
  config: OpenAITextModelConfig,
  options: AiSdkTextModelOptions = {},
): TextModel {
  const provider = createOpenAICompatible({
    name: options.name ?? "openai-compatible",
    // Keep construction lazy so an incomplete optional provider does not stop
    // the API from booting; generate/check still fail closed below.
    baseURL: config.baseUrl ?? "https://invalid.local",
    apiKey: config.apiKey,
    ...(options.fetch
      ? {
          fetch: options.fetch as NonNullable<
            Parameters<typeof createOpenAICompatible>[0]["fetch"]
          >,
        }
      : {}),
  });
  const model = provider.chatModel(config.model ?? "unconfigured-model");

  return {
    name: "openai-compatible-text-model",
    async check() {
      requireConfigured(config);
    },
    async probe() {
      requireConfigured(config);
      await generateRequest(model, config, {
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 1,
      });
    },
    async generate(input) {
      requireConfigured(config);
      return generateRequest(model, config, input);
    },
  };
}

async function generateRequest(
  model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>,
  config: OpenAITextModelConfig,
  input: TextModelRequest,
): Promise<TextModelResponse> {
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      ...(systemMessages(input).length > 0 ? { system: systemMessages(input) } : {}),
      messages: input.messages.filter((message) => message.role !== "system"),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
      ...(input.responseFormat === "json"
        ? {
            // OpenAI-compatible provider forwards unknown provider options to
            // the request body, preserving legacy JSON mode semantics.
            providerOptions: {
              openaiCompatible: { response_format: { type: "json_object" } },
            },
          }
        : {}),
      maxRetries: Math.max(0, config.maxAttempts - 1),
      timeout: config.timeoutMs,
      ...(input.requestId
        ? {
            headers: {
              "x-request-id": input.requestId,
              "x-client-request-id": input.requestId,
              "idempotency-key": input.requestId,
            },
          }
        : {}),
    });
  } catch (error) {
    throw normalizeAiSdkError(error, config.maxAttempts - 1);
  }

  return {
    content: result.text,
    provider: "openai-compatible",
    model: result.response.modelId || config.model,
    usage: {
      inputTokens: numberValue(result.usage.inputTokens),
      outputTokens: numberValue(result.usage.outputTokens),
    },
  };
}

function requireConfigured(config: OpenAITextModelConfig) {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new ProviderConfigurationError("Chat provider configuration is incomplete");
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function normalizeAiSdkError(error: unknown, retryCount: number) {
  if (error instanceof ProviderRequestError || error instanceof ProviderConfigurationError) {
    return error;
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = upstreamStatus(error);
  const name = typeof record.name === "string" ? record.name : "";
  const message = error instanceof Error ? error.message : "";
  const code =
    /timeout/i.test(name) || /timeout/i.test(message)
      ? "timeout"
      : status
        ? "http"
        : /response|parse|content|json/i.test(name + message)
          ? "response"
          : "network";
  return new ProviderRequestError("Upstream chat request failed.", {
    code,
    status,
    retryCount,
  });
}

function upstreamStatus(error: unknown, seen = new Set<unknown>(), depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 4 || seen.has(error)) return undefined;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  return upstreamStatus(record.cause, seen, depth + 1);
}

function systemMessages(input: TextModelRequest) {
  return input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}
