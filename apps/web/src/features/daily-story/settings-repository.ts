/**
 * Compatibility facade for the original Daily Story persistence import path.
 *
 * Keep this list explicit: the public surface is owned by persistence/ and
 * test-only connection seams do not become part of the stable barrel.
 */
export {
  clearAllProviders,
  clearProvider,
  readProviderSettings,
  saveAsrDirectPreference,
  saveProvider,
  writeProviderSettings,
} from "./persistence";
export {
  deleteStorySession,
  ensureDailyStorage,
  listStorySessions,
  readStorySession,
  writeStorySession,
} from "./persistence";
export { deleteDailyStoryReview, readDailyStoryReview, writeDailyStoryReview } from "./persistence";
export {
  acquireStoryLease,
  claimStoryLease,
  claimStoryLeaseToken,
  renewStoryLeaseToken,
} from "./persistence";
export { exportStorySessions, importStorySessions } from "./persistence";
export {
  DailyStorageError,
  SessionConflictError,
  StoryImportError,
  StorySidecarPersistenceError,
} from "./persistence";
export { subscribeDailyStorage } from "./persistence";
export type { DailyStorageEvent, DailyReviewSidecar } from "./persistence";
