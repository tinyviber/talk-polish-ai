import { randomUUID } from "node:crypto";

export type HttpClientConfig = {
  capability: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  maxAttempts: number;
  maxJsonResponseBytes?: number;
  maxAudioResponseBytes?: number;
};

export class ProviderConfigurationError extends Error {
  readonly code = "configuration";
}

export class ProviderRequestError extends Error {
  readonly code: "timeout" | "network" | "http" | "response";
  readonly status?: number;
  readonly retryCount: number;

  constructor(
    message: string,
    options: {
      code: ProviderRequestError["code"];
      status?: number;
      retryCount: number;
    },
  ) {
    super(message);
    this.code = options.code;
    this.status = options.status;
    this.retryCount = options.retryCount;
  }
}

export type OpenAICompatibleHttpClient = ReturnType<typeof createOpenAICompatibleHttpClient>;

export function createOpenAICompatibleHttpClient(config: HttpClientConfig) {
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");

  function url(path: string) {
    if (!baseUrl) throw new ProviderConfigurationError(`${config.capability} base URL is missing`);
    return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async function request<T>(input: {
    operation: string;
    path: string;
    parse: (response: Response) => Promise<T>;
    body?: NonNullable<RequestInit["body"]> | (() => NonNullable<RequestInit["body"]>);
    contentType?: string;
    requestId?: string;
  }): Promise<T> {
    if (!config.apiKey) {
      throw new ProviderConfigurationError(`${config.capability} API key is missing`);
    }
    const requestId = input.requestId ?? randomUUID();
    let lastError: ProviderRequestError | undefined;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const startedAt = Date.now();
      let status: number | undefined;
      try {
        const headers = new Headers({
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "x-request-id": requestId,
          "x-client-request-id": requestId,
          "idempotency-key": requestId,
        });
        if (input.contentType) headers.set("content-type", input.contentType);
        const response = await fetch(url(input.path), {
          method: "POST",
          headers,
          body: typeof input.body === "function" ? input.body() : input.body,
          signal: controller.signal,
          redirect: "error",
        });
        status = response.status;
        if (!response.ok) {
          throw new ProviderRequestError(`Upstream ${config.capability} request failed.`, {
            code: "http",
            status,
            retryCount: attempt - 1,
          });
        }
        const result = await input.parse(response);
        logRequest({
          requestId,
          capability: config.capability,
          operation: input.operation,
          durationMs: Date.now() - startedAt,
          status: "success",
          httpStatus: status,
          retryCount: attempt - 1,
        });
        return result;
      } catch (error) {
        const normalized = normalizeRequestError(
          error,
          controller.signal.aborted,
          status,
          attempt - 1,
        );
        lastError = normalized;
        const retry = attempt < config.maxAttempts && isRetryable(normalized);
        logRequest({
          requestId,
          capability: config.capability,
          operation: input.operation,
          durationMs: Date.now() - startedAt,
          status: retry ? "retry" : "failed",
          httpStatus: normalized.status,
          retryCount: normalized.retryCount,
        });
        if (!retry) throw normalized;
        await backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw (
      lastError ??
      new ProviderRequestError("Upstream request failed.", { code: "network", retryCount: 0 })
    );
  }

  return {
    requestJson<T = unknown>(input: {
      operation: string;
      path: string;
      body: unknown;
      requestId?: string;
    }) {
      return request<T>({
        ...input,
        contentType: "application/json",
        body: JSON.stringify(input.body),
        parse: async (response) =>
          JSON.parse(
            new TextDecoder().decode(
              await readLimitedBytes(response, config.maxJsonResponseBytes ?? 2 * 1024 * 1024),
            ),
          ) as T,
      });
    },
    requestMultipart<T = unknown>(input: {
      operation: string;
      path: string;
      form: () => FormData;
      requestId?: string;
    }) {
      return request<T>({
        ...input,
        body: input.form,
        parse: async (response) =>
          JSON.parse(
            new TextDecoder().decode(
              await readLimitedBytes(response, config.maxJsonResponseBytes ?? 2 * 1024 * 1024),
            ),
          ) as T,
      });
    },
    requestBytes(input: { operation: string; path: string; body: unknown; requestId?: string }) {
      return request<ArrayBuffer>({
        ...input,
        contentType: "application/json",
        body: JSON.stringify(input.body),
        parse: async (response) => {
          const bytes = await readLimitedBytes(
            response,
            config.maxAudioResponseBytes ?? 15 * 1024 * 1024,
          );
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
      });
    },
  };
}

async function readLimitedBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderRequestError("Upstream response is too large.", {
      code: "response",
      status: response.status,
      retryCount: 0,
    });
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLargeResponse(response.status);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLargeResponse(response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function tooLargeResponse(status?: number) {
  return new ProviderRequestError("Upstream response is too large.", {
    code: "response",
    status,
    retryCount: 0,
  });
}

function normalizeRequestError(
  error: unknown,
  aborted: boolean,
  status: number | undefined,
  retryCount: number,
) {
  if (error instanceof ProviderRequestError) {
    return new ProviderRequestError(error.message, {
      code: error.code,
      status: error.status,
      retryCount,
    });
  }
  if (aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ProviderRequestError("Upstream request timed out.", {
      code: "timeout",
      status,
      retryCount,
    });
  }
  return new ProviderRequestError("Upstream request could not be completed.", {
    code: status ? "http" : "network",
    status,
    retryCount,
  });
}

function isRetryable(error: ProviderRequestError) {
  return (
    error.code === "timeout" ||
    error.code === "network" ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

async function backoff(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)));
}

function logRequest(input: {
  requestId: string;
  capability: string;
  operation: string;
  durationMs: number;
  status: string;
  httpStatus?: number;
  retryCount: number;
}) {
  console.info("[provider-request]", input);
}

export function safeProviderError(error: unknown) {
  if (error instanceof ProviderConfigurationError) return "configuration";
  if (error instanceof ProviderRequestError) return error.code;
  return "provider_error";
}
