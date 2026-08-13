import { describe, expect, test } from "bun:test";
import { ProviderRequestError } from "../../../providers/http";
import {
  DailyProviderDnsError,
  DailyProviderConfigurationError,
} from "../../../platform/ai/transport";
import { DailyProviderRequestError } from "../../../platform/ai/transport";
import { createSafeProviderCall } from "./provider-call";

const safeCall = createSafeProviderCall("test");

describe("Daily Story provider error adapter", () => {
  test.each([
    [new DailyProviderConfigurationError(), 422, "validation_failed"],
    [new DailyProviderDnsError(), 422, "validation_failed"],
    [new DailyProviderRequestError("unsupported_media"), 415, "unsupported_media_type"],
    [new DailyProviderRequestError("http", 401), 401, "unauthorized"],
    [new DailyProviderRequestError("http", 429), 429, "rate_limited"],
    [new DailyProviderRequestError("http", 400), 422, "validation_failed"],
    [new DailyProviderRequestError("network"), 503, "processing_unavailable"],
    [
      new ProviderRequestError("upstream", { code: "timeout", retryCount: 0 }),
      503,
      "processing_unavailable",
    ],
  ] as const)("maps %s to %i/%s", async (error, statusCode, code) => {
    await expect(
      safeCall(async () => {
        throw error;
      }),
    ).rejects.toMatchObject({
      statusCode,
      code,
    });
  });
});
