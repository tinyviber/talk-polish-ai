import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type * as Https from "node:https";
import { DailyProviderConfigurationError, DailyProviderDnsError } from "./outbound-url-policy";
import { createDailySafeHttpsClient, DailyProviderRequestError } from "./safe-https-client";

class HangingRequest extends EventEmitter {
  destroyed = false;
  idleTimeoutCallback: (() => void) | undefined;
  timeoutMilliseconds: number | undefined;

  setTimeout(milliseconds: number, callback: () => void) {
    this.timeoutMilliseconds = milliseconds;
    this.idleTimeoutCallback = callback;
    return this;
  }

  destroy(error?: Error) {
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }

  end() {
    return this;
  }
}

class OversizedResponse extends EventEmitter {
  readonly statusCode = 200;
  readonly headers = {};
  destroyed = false;

  resume() {
    return this;
  }

  destroy() {
    this.destroyed = true;
    queueMicrotask(() => this.emit("error", new Error("premature close")));
    return this;
  }
}

class RespondingRequest extends EventEmitter {
  readonly response = new OversizedResponse();

  constructor(private readonly onResponse: (response: OversizedResponse) => void) {
    super();
  }

  setTimeout(_milliseconds: number, _callback: () => void) {
    return this;
  }

  destroy(error?: Error) {
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }

  end() {
    this.onResponse(this.response);
    queueMicrotask(() => {
      this.response.emit("data", Buffer.from("1234"));
      this.response.emit("data", Buffer.from("56"));
    });
    return this;
  }
}

class FailingRequest extends EventEmitter {
  setTimeout(_milliseconds: number, _callback: () => void) {
    return this;
  }

  destroy(error?: Error) {
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }

  end() {
    queueMicrotask(() => this.emit("error", new Error("connection reset")));
    return this;
  }
}

const requests: HangingRequest[] = [];
const requestMock = (_options: unknown, _callback: unknown) => {
  const request = new HangingRequest();
  requests.push(request);
  return request;
};

describe("Daily safe pinned HTTPS client", () => {
  test("enforces an absolute attempt timeout even when the idle timer never fires", async () => {
    requests.length = 0;
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs: 20,
        maxAttempts: 1,
        production: false,
        allowedOrigins: [],
      },
      {
        request: requestMock as unknown as typeof Https.request,
        resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );

    const outcome = await Promise.race([
      client.request({ path: "/chat/completions" }).catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 200)),
    ]);
    expect(outcome).toMatchObject({ code: "timeout" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.destroyed).toBe(true);
    expect(requests[0]?.idleTimeoutCallback).toBeDefined();
  });

  test("times out a production request when DNS resolution never completes", async () => {
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs: 20,
        maxAttempts: 1,
        production: true,
        allowedOrigins: ["https://provider.example.com"],
      },
      {
        resolveAddresses: () => new Promise<never>(() => {}),
      },
    );

    const outcome = await Promise.race([
      client.request({ path: "/chat/completions" }).catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 200)),
    ]);
    expect(outcome).toBeInstanceOf(DailyProviderRequestError);
    expect(outcome).toMatchObject({ code: "timeout" });
  });

  test("shares one attempt deadline between slow DNS and the pinned request", async () => {
    requests.length = 0;
    const timeoutMs = 120;
    const startedAt = Date.now();
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs,
        maxAttempts: 1,
        production: true,
        allowedOrigins: ["https://provider.example.com"],
      },
      {
        request: requestMock as unknown as typeof Https.request,
        resolveAddresses: async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
          return [{ address: "8.8.8.8", family: 4 }];
        },
      },
    );

    const outcome = await client
      .request({ path: "/chat/completions" })
      .catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toMatchObject({ code: "timeout" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.timeoutMilliseconds).toBeLessThan(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 50);
  });

  test("returns the pinned address array for Node's all-address lookup path", async () => {
    let lookupResult:
      | {
          error: unknown;
          address: unknown;
          family: unknown;
        }
      | undefined;
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs: 20,
        maxAttempts: 1,
        production: true,
        allowedOrigins: ["https://provider.example.com"],
      },
      {
        request: ((options: unknown) => {
          const lookup = (
            options as {
              lookup: (
                hostname: string,
                lookupOptions: { all?: boolean },
                callback: (error: unknown, address: unknown, family?: unknown) => void,
              ) => void;
            }
          ).lookup;
          lookup("provider.example.com", { all: true }, (error, address, family) => {
            lookupResult = { error, address, family };
          });
          return new HangingRequest();
        }) as unknown as typeof Https.request,
        resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );

    const outcome = await client
      .request({ path: "/chat/completions" })
      .catch((error: unknown) => error);

    expect(lookupResult).toEqual({
      error: null,
      address: [{ address: "8.8.8.8", family: 4 }],
      family: undefined,
    });
    expect(outcome).toMatchObject({ code: "timeout" });
  });

  test("uses one end-to-end deadline across pinned retries and backoff", async () => {
    const pinnedRequests: FailingRequest[] = [];
    const timeoutMs = 260;
    const startedAt = Date.now();
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs,
        maxAttempts: 3,
        production: true,
        allowedOrigins: ["https://provider.example.com"],
      },
      {
        request: ((_options: unknown, _callback: unknown) => {
          const request = new FailingRequest();
          pinnedRequests.push(request);
          return request;
        }) as unknown as typeof Https.request,
        resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );

    const outcome = await client
      .request({ path: "/chat/completions" })
      .catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toMatchObject({ code: "timeout" });
    expect(pinnedRequests).toHaveLength(2);
    expect(elapsedMs).toBeLessThan(timeoutMs + 120);
  });

  test("passes only the remaining request budget to a retried synthetic fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSignals: AbortSignal[] = [];
    const timeoutMs = 260;
    const startedAt = Date.now();
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      if (signal) fetchSignals.push(signal);
      if (calls === 1) throw new Error("connection reset");
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    }) as typeof fetch;

    try {
      const client = createDailySafeHttpsClient({
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs,
        maxAttempts: 2,
        production: false,
        allowSyntheticDns: true,
        allowedOrigins: [],
      });

      const outcome = await client
        .request({ path: "/chat/completions" })
        .catch((error: unknown) => error);
      const elapsedMs = Date.now() - startedAt;

      expect(outcome).toMatchObject({ code: "timeout" });
      expect(calls).toBe(2);
      expect(fetchSignals[1]?.aborted).toBe(true);
      expect(elapsedMs).toBeLessThan(timeoutMs + 120);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves provider DNS and configuration errors without retrying", async () => {
    for (const boundaryError of [
      new DailyProviderDnsError(),
      new DailyProviderConfigurationError(),
    ]) {
      let resolveCalls = 0;
      const client = createDailySafeHttpsClient(
        {
          baseUrl: "https://provider.example.com/v1",
          apiKey: "fixture-key",
          timeoutMs: 100,
          maxAttempts: 3,
          production: true,
          allowedOrigins: ["https://provider.example.com"],
        },
        {
          resolveAddresses: async () => {
            resolveCalls += 1;
            throw boundaryError;
          },
        },
      );

      const outcome = await client
        .request({ path: "/chat/completions" })
        .catch((error: unknown) => error);

      expect(outcome).toBe(boundaryError);
      expect(outcome).toBeInstanceOf(boundaryError.constructor);
      expect(resolveCalls).toBe(1);
    }
  });

  test("redacts the configured API key from synthetic HTTP diagnostics", async () => {
    const originalFetch = globalThis.fetch;
    const apiKey = "dashscope-key-123";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: `Invalid API key: ${apiKey}` } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const client = createDailySafeHttpsClient({
        baseUrl: "https://provider.example.com/v1",
        apiKey,
        timeoutMs: 100,
        maxAttempts: 1,
        production: false,
        allowSyntheticDns: true,
        allowedOrigins: [],
      });

      const outcome = await client
        .request({ path: "/chat/completions" })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(DailyProviderRequestError);
      expect(outcome).toMatchObject({
        code: "http",
        status: 400,
        reason: "Invalid API key: <redacted>",
      });
      expect((outcome as DailyProviderRequestError).reason).not.toContain(apiKey);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("classifies an oversized chunked response as response without retrying", async () => {
    const oversizedRequests: RespondingRequest[] = [];
    const client = createDailySafeHttpsClient(
      {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "fixture-key",
        timeoutMs: 100,
        maxAttempts: 3,
        production: false,
        allowedOrigins: [],
      },
      {
        request: ((_options: unknown, callback: unknown) => {
          const request = new RespondingRequest(callback as (response: OversizedResponse) => void);
          oversizedRequests.push(request);
          return request;
        }) as unknown as typeof Https.request,
        resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );

    const outcome = await client
      .request({ path: "/chat/completions", maxResponseBytes: 5 })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(DailyProviderRequestError);
    expect(outcome).toMatchObject({ code: "response" });
    expect(oversizedRequests).toHaveLength(1);
    expect(oversizedRequests[0]?.response.destroyed).toBe(true);
  });
});
