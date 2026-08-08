import { request as httpsRequest } from "node:https";
import {
  assertDailyProviderUrlAllowed,
  joinDailyProviderPath,
  resolveDailyProviderPublicAddresses,
  type DailyProviderTarget,
  type DailyProviderUrlPolicy,
} from "./outbound-url-policy";

export class DailyProviderRequestError extends Error {
  readonly code: "timeout" | "network" | "http" | "redirect" | "response";
  readonly status?: number;
  constructor(code: DailyProviderRequestError["code"], status?: number) {
    super("Daily Story provider request failed.");
    this.code = code;
    this.status = status;
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

/**
 * Dynamic OpenAI-compatible transport. Never uses fetch: every attempt resolves
 * all DNS answers, dials one validated numeric address, retains TLS SNI/Host,
 * disables redirects and keep-alive, and bounds response bytes.
 */
export function createDailySafeHttpsClient(options: DailySafeHttpsClientOptions) {
  const target = assertDailyProviderUrlAllowed(options.baseUrl, options);

  return {
    async request(input: RequestInput): Promise<SafeResponse> {
      let lastError: DailyProviderRequestError | undefined;
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        try {
          // This call intentionally remains inside retry loop: DNS is not cached.
          const addresses = await resolveDailyProviderPublicAddresses(target.hostname);
          const selected = addresses[0]!;
          const response = await requestPinned(target, selected, input, options);
          if (response.status >= 300 && response.status < 400) {
            throw new DailyProviderRequestError("redirect", response.status);
          }
          if (response.status < 200 || response.status >= 300) {
            throw new DailyProviderRequestError("http", response.status);
          }
          return response;
        } catch (error) {
          const normalized = normalizeError(error);
          lastError = normalized;
          if (attempt >= options.maxAttempts || !retryable(normalized)) throw normalized;
          await backoff(attempt);
        }
      }
      throw lastError ?? new DailyProviderRequestError("network");
    },
  };
}

function requestPinned(
  target: DailyProviderTarget,
  selected: { address: string; family: 4 | 6 },
  input: RequestInput,
  options: DailySafeHttpsClientOptions,
): Promise<SafeResponse> {
  const url = joinDailyProviderPath(target, input.path);
  const body = input.body ? Buffer.from(input.body) : undefined;
  const maxBytes = input.maxResponseBytes ?? options.maxResponseBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
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
          reject(new DailyProviderRequestError("response", response.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new DailyProviderRequestError("network", response.statusCode)),
        );
        response.on("end", () => {
          if (size > maxBytes) {
            reject(new DailyProviderRequestError("response", response.statusCode));
            return;
          }
          const bytes = Buffer.concat(chunks);
          const rawContentType = response.headers["content-type"];
          const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
          resolve({
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ...(contentType ? { contentType } : {}),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error: NodeJS.ErrnoException) => {
      reject(new DailyProviderRequestError(error.message === "timeout" ? "timeout" : "network"));
    });
    request.end(body);
  });
}

function normalizeError(error: unknown) {
  if (error instanceof DailyProviderRequestError) return error;
  return new DailyProviderRequestError("network");
}

function retryable(error: DailyProviderRequestError) {
  return (
    error.code === "timeout" ||
    error.code === "network" ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

async function backoff(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** (attempt - 1), 800)));
}
