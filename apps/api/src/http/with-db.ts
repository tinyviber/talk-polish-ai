import { ApiError } from "./errors";

/**
 * Wraps a database call so driver-level failures surface as a safe 503 instead
 * of leaking connection strings or stack traces to the browser.
 */
export async function withDb<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error(`[db] ${label} failed:`, error instanceof Error ? error.message : error);
    throw ApiError.database();
  }
}
