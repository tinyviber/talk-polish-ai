export const DAILY_REVIEW_ERROR_DETAIL_MAX_CHARS = 160;

/** Convert server diagnostics into short, safe lines for the review error card. */
export function formatDailyReviewErrorDetails(details: unknown): string[] {
  return flattenDetails(details)
    .map(stringifyDetail)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => truncateDetail(value, DAILY_REVIEW_ERROR_DETAIL_MAX_CHARS));
}

function flattenDetails(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenDetails);
  if (isRecord(value)) {
    for (const key of ["errors", "rawErrors", "details"]) {
      if (key in value) return flattenDetails(value[key]);
    }
  }
  return value === undefined || value === null ? [] : [value];
}

function stringifyDetail(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function truncateDetail(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
