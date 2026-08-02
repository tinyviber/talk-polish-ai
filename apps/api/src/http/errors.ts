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
  static processingUnavailable(message = "Speech processing is temporarily unavailable.") {
    return new ApiError(503, "processing_unavailable", message);
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

  static internal(message = "Something went wrong while processing the request.") {
    return new ApiError(500, "internal_error", message);
  }
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
