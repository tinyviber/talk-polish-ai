import type { ErrorCode, ErrorResponse } from "@kotoba/contracts";

/** Domain-level error that maps cleanly onto an HTTP status + safe payload. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: string[] | undefined;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: string[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: string[]) {
    return new ApiError(400, "bad_request", message, details);
  }
  static validation(message: string, details?: string[]) {
    return new ApiError(422, "validation_failed", message, details);
  }
  static unauthorized(message = "A valid learner token is required.") {
    return new ApiError(401, "unauthorized", message);
  }
  static conflict(message: string) {
    return new ApiError(409, "conflict", message);
  }
  static missingAudio(message = "An audio recording is required for this attempt.") {
    return new ApiError(400, "missing_audio", message);
  }
  static unsupportedMedia(message: string, details?: string[]) {
    return new ApiError(415, "unsupported_media_type", message, details);
  }
  static tooLarge(message: string) {
    return new ApiError(413, "payload_too_large", message);
  }
  static notFound(what: string) {
    return new ApiError(404, "not_found", `${what} was not found.`);
  }
  static processingUnavailable(
    message = "Speech processing is temporarily unavailable.",
    details?: string[],
  ) {
    return new ApiError(503, "processing_unavailable", message, details);
  }
  static storage(message = "Could not store the recording.") {
    return new ApiError(503, "storage_failure", message);
  }
  static database(message = "The database is unavailable. Please try again.") {
    return new ApiError(503, "database_failure", message);
  }
  static rateLimited(
    message = "This capability is temporarily rate limited. Please try again later.",
  ) {
    return new ApiError(429, "rate_limited", message);
  }

  static internal(
    message = "Something went wrong while processing the request.",
    details?: string[],
  ) {
    return new ApiError(500, "internal_error", message, details);
  }
}

const SAFE_ERROR_DETAIL_MAX_CHARS = 160;

/** Convert unknown exceptions to short, user-presentable diagnostics. */
export function safeErrorDetail(error: unknown) {
  const raw = rawErrorText(error);
  if (!raw) return "An unknown exception was raised.";
  if (
    /prompt|messages?|<story_|<history_|<learner_user_turns_|api[ _-]?key|authorization|bearer|token|secret|password/i.test(
      raw,
    )
  ) {
    return "Error details were redacted for safety.";
  }
  const compact = raw.replace(/\s+/g, " ").trim();
  const redacted = compact.replace(
    /((?:api[ _-]?key|authorization|bearer|token|secret|password)\s*[:=]\s*)[^,;\s]+/gi,
    "$1[REDACTED]",
  );
  return redacted.length > SAFE_ERROR_DETAIL_MAX_CHARS
    ? `${redacted.slice(0, SAFE_ERROR_DETAIL_MAX_CHARS)}…`
    : redacted;
}

function rawErrorText(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function toErrorResponse(error: ApiError, requestId: string): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    requestId,
  };
}
