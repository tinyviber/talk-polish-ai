export type DailyStorageEvent =
  | { kind: "settings"; revision: number }
  | { kind: "session"; conversationId: string; revision: number }
  | { kind: "lease"; conversationId: string; ownerId: string }
  | { kind: "leaseReleased"; conversationId: string; ownerId: string };

let channel: BroadcastChannel | undefined;
const listeners = new Set<(event: DailyStorageEvent) => void>();

function storageChannel() {
  if (typeof BroadcastChannel === "undefined") return undefined;
  channel ??= new BroadcastChannel("kotoba-daily-story-v1");
  return channel;
}

export function notifySettings(revision: number) {
  storageChannel()?.postMessage({ kind: "settings", revision });
}

export function notifySession(conversationId: string, revision: number) {
  storageChannel()?.postMessage({ kind: "session", conversationId, revision });
}

export function notifyLease(conversationId: string, ownerId: string) {
  storageChannel()?.postMessage({ kind: "lease", conversationId, ownerId });
}

export function notifyLeaseReleased(conversationId: string, ownerId: string) {
  const event = { kind: "leaseReleased" as const, conversationId, ownerId };
  // BroadcastChannel does not deliver to the sending channel object. Emit to
  // same-document listeners too, which covers rapid remounts in one tab.
  listeners.forEach((callback) => callback(event));
  storageChannel()?.postMessage(event);
}

export function subscribeDailyStorage(listener: (event: DailyStorageEvent) => void) {
  listeners.add(listener);
  const currentChannel = storageChannel();
  if (currentChannel) {
    currentChannel.onmessage = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      const { kind, conversationId, revision, ownerId } = payload as {
        kind?: unknown;
        conversationId?: unknown;
        revision?: unknown;
        ownerId?: unknown;
      };
      if (kind === "settings" && typeof revision === "number") {
        listeners.forEach((callback) => callback({ kind, revision }));
      } else if (
        kind === "session" &&
        typeof conversationId === "string" &&
        typeof revision === "number"
      ) {
        listeners.forEach((callback) => callback({ kind, conversationId, revision }));
      } else if (
        kind === "lease" &&
        typeof conversationId === "string" &&
        typeof ownerId === "string"
      ) {
        listeners.forEach((callback) => callback({ kind, conversationId, ownerId }));
      } else if (
        kind === "leaseReleased" &&
        typeof conversationId === "string" &&
        typeof ownerId === "string"
      ) {
        listeners.forEach((callback) => callback({ kind, conversationId, ownerId }));
      }
    };
  }
  return () => listeners.delete(listener);
}
