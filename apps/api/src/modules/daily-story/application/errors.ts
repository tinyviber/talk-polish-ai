import type { ErrorCode } from "@kotoba/contracts";

export class DailyStoryApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = "DailyStoryApplicationError";
  }
}

export const dailyStoryValidation = (message: string) =>
  new DailyStoryApplicationError(422, "validation_failed", message);
