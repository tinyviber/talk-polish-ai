import { database, resetCachedConnection, resetCachedReviewConnection } from "./internal/database";

/** Test-only seam: clear the cached connection so the next operation reopens it. */
export async function __resetDailyStorageForTests() {
  resetCachedConnection();
  resetCachedReviewConnection();
}

/** Test-only seam: leave the stale connection cached so the next operation must recover it. */
export async function __closeDailyStorageConnectionForTests() {
  const db = await database();
  db.close();
}
