import { describe, expect, test } from "bun:test";
import { ProviderRequestError } from "../../../providers/http";
import { StructuredGenerationError } from "../../../capabilities/structured-generator";
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

  test("keeps safe truncated details for non-Error exceptions", async () => {
    const result = await safeCall(async () => {
      throw { message: `provider failed ${"x".repeat(300)}`, apiKey: "secret-provider-key" };
    }).catch((error: unknown) => error as { statusCode: number; code: string; details: string[] });

    expect(result).toMatchObject({ statusCode: 503, code: "processing_unavailable" });
    expect(result.details).toEqual([expect.stringContaining("provider failed")]);
    expect(result.details[0]!.length).toBeLessThanOrEqual(161);
    expect(result.details[0]!).not.toContain("secret-provider-key");
  });

  test("exposes only safe schema paths for structured output failures", async () => {
    const result = await safeCall(async () => {
      throw new StructuredGenerationError("raw model output must not escape", {
        first: {
          error: {
            issues: [
              {
                path: ["suggestions", 0, "explanationZh"],
                code: "invalid_type",
                message: "Expected string, received number",
              },
            ],
          },
        },
      });
    }).catch((error: unknown) => error as { statusCode: number; code: string; details: string[] });

    expect(result).toMatchObject({ statusCode: 503, code: "processing_unavailable" });
    expect(result.details[0]!).toContain("first suggestions.0.explanationZh: Expected string");
    expect(result.details.join(" ")).not.toContain("raw model output");
  });
});
