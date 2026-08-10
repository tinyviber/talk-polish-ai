import { request as httpsRequest } from "node:https";
import {
  assertDailyProviderUrlAllowed,
  DailyProviderConfigurationError,
  DailyProviderDnsError,
  joinDailyProviderPath,
  resolveDailyProviderPublicAddresses,
  type DailyProviderTarget,
  type DailyProviderUrlPolicy,
} from "./outbound-url-policy";

export class DailyProviderRequestError extends Error {
  readonly code: "timeout" | "network" | "http" | "redirect" | "response";
  readonly status?: number;
  readonly reason?: string;
  constructor(code: DailyProviderRequestError["code"], status?: number, reason?: string) {
    super("Daily Story provider request failed.");
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export type DailySafeHttpsClientOptions = DailyProviderUrlPolicy & {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  maxResponseBytes?: number;
};

type RequestInput = {
  path: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
  requestId?: string;
  accept?: string;
  maxResponseBytes?: number;
};

type SafeResponse = { bytes: Uint8Array; contentType?: string; status: number };
type DailySafeHttpsClientDependencies = {
  resolveAddresses?: typeof resolveDailyProviderPublicAddresses;
  request?: typeof httpsRequest;
};

/**
 * Dynamic OpenAI-compatible transport. Never uses fetch: every attempt resolves
 * all DNS answers, dials one validated numeric address, retains TLS SNI/Host,
 * disables redirects and keep-alive, and bounds response bytes.
 */
export function createDailySafeHttpsClient(
  options: DailySafeHttpsClientOptions,
  dependencies: DailySafeHttpsClientDependencies = {},
) {
  const target = assertDailyProviderUrlAllowed(options.baseUrl, options);
  const resolveAddresses = dependencies.resolveAddresses ?? resolveDailyProviderPublicAddresses;
  const request = dependencies.request ?? httpsRequest;

  return {
    async request(input: RequestInput): Promise<SafeResponse> {
      const deadline = Date.now() + options.timeoutMs;
      let lastError: DailyProviderRequestError | undefined;
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        try {
          if (remainingDeadlineMs(deadline) <= 0) {
            throw new DailyProviderRequestError("timeout");
          }
          if (options.allowSyntheticDns && !options.production) {
            const response = await requestWithSystemFetch(target, input, options, deadline);
            if (remainingDeadlineMs(deadline) <= 0) {
              throw new DailyProviderRequestError("timeout");
            }
            return response;
          }
          // This call intentionally remains inside retry loop: DNS is not cached.
          const addresses = await withTimeout(
            resolveAddresses(
              target.hostname,
              undefined,
              options.allowSyntheticDns && !options.production,
            ),
            remainingDeadlineMs(deadline),
          );
          const selected = addresses[0]!;
          const response = await requestPinned(target, selected, input, options, request, deadline);
          if (remainingDeadlineMs(deadline) <= 0) {
            throw new DailyProviderRequestError("timeout");
          }
          if (response.status >= 300 && response.status < 400) {
            throw new DailyProviderRequestError("redirect", response.status);
          }
          if (response.status < 200 || response.status >= 300) {
            throw new DailyProviderRequestError("http", response.status);
          }
          return response;
        } catch (error) {
          if (
            error instanceof DailyProviderDnsError ||
            error instanceof DailyProviderConfigurationError
          ) {
            throw error;
          }
          const normalized = normalizeError(error);
          lastError = normalized;
          if (attempt >= options.maxAttempts || !retryable(normalized)) throw normalized;
          await backoff(attempt, deadline);
        }
      }
      throw lastError ?? new DailyProviderRequestError("network");
    },
  };
}

async function requestWithSystemFetch(
  target: DailyProviderTarget,
  input: RequestInput,
  options: DailySafeHttpsClientOptions,
  deadline: number,
): Promise<SafeResponse> {
  const url = joinDailyProviderPath(target, input.path);
  const body = input.body ? new Uint8Array(input.body) : undefined;
  const maxBytes = input.maxResponseBytes ?? options.maxResponseBytes ?? 2 * 1024 * 1024;
  const headers = new Headers({
    accept: input.accept ?? "application/json",
    authorization: `Bearer ${options.apiKey}`,
    ...(input.requestId
      ? {
          "x-request-id": input.requestId,
          "x-client-request-id": input.requestId,
          "idempotency-key": input.requestId,
        }
      : {}),
    ...input.headers,
  });
  const controller = new AbortController();
  const remaining = remainingDeadlineMs(deadline);
  if (remaining <= 0) {
    throw new DailyProviderRequestError("timeout");
  }
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      ...(body ? { body } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new DailyProviderRequestError("redirect", response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DailyProviderRequestError(
        "http",
        response.status,
        await providerResponseReason(response, options.apiKey),
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new DailyProviderRequestError("response", response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new DailyProviderRequestError("response", response.status);
    }
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? undefined,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof DailyProviderRequestError) throw error;
    throw new DailyProviderRequestError(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

async function providerResponseReason(response: Response, secret: string) {
  try {
    const text = await response.text();
    if (!text) return undefined;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Keep only a short, non-JSON diagnostic below.
    }
    const message =
      value && typeof value === "object" && "error" in value && value.error
        ? typeof value.error === "object" && "message" in value.error
          ? value.error.message
          : value.error
        : value && typeof value === "object" && "message" in value
          ? value.message
          : value;
    if (typeof message !== "string") return undefined;
    const redacted = secret ? message.split(secret).join("<redacted>") : message;
    return redacted
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/sk-[a-z0-9_-]+/gi, "sk-<redacted>")
      .slice(0, 400);
  } catch {
    return undefined;
  }
}

function requestPinned(
  target: DailyProviderTarget,
  selected: { address: string; family: 4 | 6 },
  input: RequestInput,
  options: DailySafeHttpsClientOptions,
  requestFn: typeof httpsRequest,
  deadline: number,
): Promise<SafeResponse> {
  const url = joinDailyProviderPath(target, input.path);
  const body = input.body ? Buffer.from(input.body) : undefined;
  const maxBytes = input.maxResponseBytes ?? options.maxResponseBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let totalTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let responseLimitExceeded = false;
    const cleanup = () => {
      if (totalTimeout !== undefined) {
        clearTimeout(totalTimeout);
        totalTimeout = undefined;
      }
    };
    const fail = (error: DailyProviderRequestError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (response: SafeResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const remaining = remainingDeadlineMs(deadline);
    if (remaining <= 0) {
      fail(new DailyProviderRequestError("timeout"));
      return;
    }
    const request = requestFn(
      {
        protocol: "https:",
        hostname: target.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        agent: false,
        servername: target.hostname,
        rejectUnauthorized: true,
        lookup(_hostname, _lookupOptions, callback) {
          callback(null, selected.address, selected.family);
        },
        headers: {
          host: target.hostname,
          accept: input.accept ?? "application/json",
          authorization: `Bearer ${options.apiKey}`,
          ...(input.requestId
            ? {
                "x-request-id": input.requestId,
                "x-client-request-id": input.requestId,
                "idempotency-key": input.requestId,
              }
            : {}),
          ...(body ? { "content-length": String(body.byteLength) } : {}),
          ...input.headers,
        },
      },
      (response) => {
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.resume();
          fail(new DailyProviderRequestError("response", response.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            responseLimitExceeded = true;
            fail(new DailyProviderRequestError("response", response.statusCode));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => {
          if (!responseLimitExceeded) {
            fail(new DailyProviderRequestError("network", response.statusCode));
          }
        });
        response.on("end", () => {
          if (size > maxBytes) {
            fail(new DailyProviderRequestError("response", response.statusCode));
            return;
          }
          const bytes = Buffer.concat(chunks);
          const rawContentType = response.headers["content-type"];
          const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
          succeed({
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ...(contentType ? { contentType } : {}),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    // Keep the idle timeout below for stalled sockets, but also bound the full
    // attempt so a peer sending occasional bytes cannot keep it alive forever.
    totalTimeout = setTimeout(() => request.destroy(new Error("timeout")), remaining);
    request.setTimeout(remaining, () => request.destroy(new Error("timeout")));
    request.on("error", (error: NodeJS.ErrnoException) => {
      fail(new DailyProviderRequestError(error.message === "timeout" ? "timeout" : "network"));
    });
    request.end(body);
  });
}

function normalizeError(error: unknown) {
  if (error instanceof DailyProviderRequestError) return error;
  return new DailyProviderRequestError("network");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DailyProviderRequestError("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function remainingDeadlineMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

function retryable(error: DailyProviderRequestError) {
  return (
    error.code === "timeout" ||
    error.code === "network" ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

async function backoff(attempt: number, deadline: number) {
  const delay = Math.min(200 * 2 ** (attempt - 1), 800);
  const remaining = remainingDeadlineMs(deadline);
  if (remaining <= 0) {
    throw new DailyProviderRequestError("timeout");
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
  if (remainingDeadlineMs(deadline) <= 0 || delay >= remaining) {
    throw new DailyProviderRequestError("timeout");
  }
}
