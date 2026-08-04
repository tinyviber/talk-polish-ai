import type { SyncResult } from "./offlineQueue";

export type OfflineQueueSyncLoopOptions = {
  getLearnerIds: () => string[];
  getNextPollAt: (learnerIds: string[]) => Promise<number | null>;
  syncQueue: (learnerIds: string[]) => Promise<SyncResult | void>;
  setBusy?: (busy: boolean, reason: "queue") => void;
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  nav?: Pick<Navigator, "onLine">;
  win?: Pick<Window, "addEventListener" | "removeEventListener"> & {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };
};

export function startOfflineQueueSyncLoop({
  getLearnerIds,
  getNextPollAt,
  syncQueue,
  setBusy,
  doc = typeof document !== "undefined" ? document : undefined,
  nav = typeof navigator !== "undefined" ? navigator : undefined,
  win = typeof window !== "undefined" ? window : undefined,
}: OfflineQueueSyncLoopOptions) {
  if (!doc || !nav || !win) return () => {};

  let disposed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let syncInFlight: Promise<SyncResult | void> | null = null;
  let trailingSyncRequested = false;
  let planningInFlight: Promise<void> | null = null;
  let replanRequested = false;
  let leaseRetryAt: number | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    win.clearTimeout(timer);
    timer = null;
  };

  const scheduleNextSync = async (retryAt?: number): Promise<void> => {
    if (retryAt !== undefined) {
      leaseRetryAt = Math.max(leaseRetryAt ?? 0, retryAt);
    }
    if (disposed) return;
    if (planningInFlight) {
      replanRequested = true;
      return planningInFlight;
    }
    planningInFlight = (async () => {
      do {
        replanRequested = false;
        clearTimer();
        if (disposed || nav.onLine === false) continue;
        const learnerIds = getLearnerIds();
        const nextPollAt = await getNextPollAt(learnerIds);
        if (disposed) continue;
        if (nextPollAt === null) {
          leaseRetryAt = null;
          continue;
        }
        const wakeAt = Math.max(nextPollAt, leaseRetryAt ?? 0);
        const delay = Math.max(0, wakeAt - Date.now());
        if (delay === 0) {
          requestSync();
        } else {
          timer = win.setTimeout(() => {
            timer = null;
            requestSync();
          }, delay);
        }
      } while (replanRequested && !disposed);
    })().finally(() => {
      planningInFlight = null;
    });
    return planningInFlight;
  };

  const runSync = () => {
    if (disposed || syncInFlight || nav.onLine === false) return;
    clearTimer();
    setBusy?.(true, "queue");
    let syncResult: SyncResult | void;
    syncInFlight = syncQueue(getLearnerIds())
      .then((result) => {
        syncResult = result;
        if (result && !result.acquired) {
          leaseRetryAt = Math.max(leaseRetryAt ?? 0, result.retryAt);
        } else if (result?.acquired) {
          leaseRetryAt = null;
        }
        return result;
      })
      .finally(() => {
        setBusy?.(false, "queue");
      })
      .finally(async () => {
        syncInFlight = null;
        if (disposed) return;
        if (trailingSyncRequested) {
          trailingSyncRequested = false;
          if (syncResult && !syncResult.acquired) {
            await scheduleNextSync();
            return;
          }
          runSync();
          return;
        }
        await scheduleNextSync();
      });
  };

  function requestSync() {
    if (disposed) return;
    if (syncInFlight) {
      trailingSyncRequested = true;
      return;
    }
    runSync();
  }

  const handleQueueChange = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.internal === true) return;
    void scheduleNextSync();
  };
  const handleVisible = () => {
    if (doc.visibilityState === "visible") void scheduleNextSync();
  };

  void scheduleNextSync();
  win.addEventListener("online", handleQueueChange);
  win.addEventListener("kotoba:queue-change", handleQueueChange);
  win.addEventListener("kotoba:retry-queue", handleQueueChange);
  win.addEventListener("kotoba:learner-ready", handleQueueChange);
  doc.addEventListener("visibilitychange", handleVisible);

  return () => {
    disposed = true;
    clearTimer();
    win.removeEventListener("online", handleQueueChange);
    win.removeEventListener("kotoba:queue-change", handleQueueChange);
    win.removeEventListener("kotoba:retry-queue", handleQueueChange);
    win.removeEventListener("kotoba:learner-ready", handleQueueChange);
    doc.removeEventListener("visibilitychange", handleVisible);
  };
}
