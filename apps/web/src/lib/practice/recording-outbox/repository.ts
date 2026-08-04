/** Repository boundary marker. IndexedDB transaction code remains in offlineQueue during migration. */
export type RecordingOutboxRepository<T> = {
  list(learnerIds?: string | string[]): Promise<T[]>;
};
