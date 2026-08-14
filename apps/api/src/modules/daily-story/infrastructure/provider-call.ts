import {
  DailyProviderConfigurationError,
  DailyProviderDnsError,
  DailyProviderRequestError,
} from "../../../platform/ai/transport";
import { StructuredGenerationError } from "../../../capabilities/structured-generator";
import { ApiError, safeErrorDetail } from "../../../http/errors";
import { ProviderConfigurationError, ProviderRequestError } from "../../../providers/http";
import type { SafeProviderCall } from "../application/ports";
import { DailyStoryApplicationError, dailyStoryValidation } from "../application/errors";

/** Infrastructure adapter: hides upstream/provider failures behind API errors. */
export function createSafeProviderCall(nodeEnv: string): SafeProviderCall {
  return async <T>(run: () => Promise<T>, requestId?: string) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DailyStoryApplicationError) throw error;
      const details = providerErrorDetails(error);
      if (error instanceof Error) {
        console.warn("[daily-story provider error]", {
          ...(requestId ? { requestId } : {}),
          name: error.constructor.name,
          message: error.message,
          ...(error instanceof DailyProviderRequestError || error instanceof ProviderRequestError
            ? { code: error.code, status: error.status }
            : {}),
          ...(error instanceof StructuredGenerationError
            ? { schemaIssues: structuredSchemaIssues(error.cause) }
            : {}),
          details,
        });
      } else {
        console.warn("[daily-story provider exception]", {
          ...(requestId ? { requestId } : {}),
          details,
        });
      }
      if (
        error instanceof DailyProviderConfigurationError ||
        error instanceof DailyProviderDnsError ||
        error instanceof ProviderConfigurationError ||
        (error instanceof Error && error.name === "DailyStoryProviderNotConfiguredError")
      ) {
        throw ApiError.validation("Daily Story provider configuration is invalid.", details);
      }
      if (error instanceof DailyProviderRequestError || error instanceof ProviderRequestError) {
        if (error.status === 401 || error.status === 403)
          throw ApiError.unauthorized("Daily Story provider credentials were rejected.");
        if (error.status === 429)
          throw ApiError.rateLimited(
            "Daily Story provider rate limit reached. Please try again later.",
          );
        if (error.status === 400 || error.status === 404 || error.status === 405) {
          throw ApiError.validation(
            nodeEnv !== "production" && error instanceof DailyProviderRequestError && error.reason
              ? `Daily Story provider rejected the request: ${error.reason}`
              : "Daily Story provider configuration is invalid.",
            details,
          );
        }
        if (error instanceof DailyProviderRequestError && error.code === "unsupported_media")
          throw ApiError.unsupportedMedia("Fun-ASR 仅支持 WAV 或 MP3 音频。请重新录音后重试。");
      }
      throw ApiError.processingUnavailable(
        "Daily Story provider is temporarily unavailable.",
        details,
      );
    }
  };
}

function providerErrorDetails(error: unknown) {
  if (!(error instanceof StructuredGenerationError)) return [safeErrorDetail(error)];
  const issues = structuredSchemaIssues(error.cause);
  if (issues.length === 0) return ["Structured model output failed schema validation."];
  return issues.slice(0, 8).map((issue) => {
    if ("shape" in issue) return `${issue.attempt}: model output shape was invalid.`;
    const path = issue.path.length > 0 ? issue.path.join(".") : "$";
    return `${issue.attempt} ${path}: ${issue.message ?? issue.code}`;
  });
}

function structuredSchemaIssues(cause: unknown) {
  if (!cause || typeof cause !== "object") return [];
  const record = cause as { first?: unknown; repair?: unknown };
  return ["first", "repair"].flatMap((attempt) => {
    const value = record[attempt as "first" | "repair"];
    if (!value || typeof value !== "object") return [];
    const item = value as { error?: { issues?: unknown }; shape?: unknown };
    const issues = item.error?.issues;
    if (!Array.isArray(issues)) return [];
    const result = issues.slice(0, 8).flatMap((issue) => {
      if (!issue || typeof issue !== "object") return [];
      const issueRecord = issue as { path?: unknown; code?: unknown; message?: unknown };
      return [
        {
          attempt,
          path: Array.isArray(issueRecord.path) ? issueRecord.path.slice(0, 6) : [],
          code: typeof issueRecord.code === "string" ? issueRecord.code : "unknown",
          message:
            typeof issueRecord.message === "string"
              ? safeErrorDetail(issueRecord.message)
              : undefined,
        },
      ];
    });
    return item.shape ? [...result, { attempt, shape: item.shape }] : result;
  });
}
