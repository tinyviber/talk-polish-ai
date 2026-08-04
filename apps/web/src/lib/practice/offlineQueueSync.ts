export type OfflineQueueSyncLoopOptions = {
  getLearnerIds: () => string[];
  getNextPollAt: (learnerIds: string[]) => Promise<number | null>;
  syncQueue: (learnerIds: string[]) => Promise<void>;
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
  let syncInFlight: Promise<void> | null = null;
  let trailingSyncRequested = false;
  let planningInFlight: Promise<void> | null = null;
  let replanRequested = false;

  const clearTimer = () => {
    if (timer === null) return;
    win.clearTimeout(timer);
    timer = null;
  };

  const scheduleNextSync = async (): Promise<void> => {
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
        if (disposed || nextPollAt === null) continue;
        const delay = Math.max(0, nextPollAt - Date.now());
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
    syncInFlight = syncQueue(getLearnerIds())
      .finally(() => {
        setBusy?.(false, "queue");
      })
      .finally(async () => {
        syncInFlight = null;
        if (disposed) return;
        if (trailingSyncRequested) {
          trailingSyncRequested = false;
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

  const handleQueueChange = () => {
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
