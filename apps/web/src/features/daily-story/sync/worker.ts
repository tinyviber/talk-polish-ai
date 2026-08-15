import type { DailyStorySyncConversation, DailyStorySyncRemoteObject } from "@kotoba/contracts";
import { createConversationId, type StorySession } from "../types";
import {
  conflictConversationId,
  conflictKey,
  dropSyncOutbox,
  fromSyncConversation,
  isStorySyncSuppressed,
  listSyncOutbox,
  listSyncConflicts,
  markRemoteRevision,
  markSyncAttempt,
  markSyncSuccess,
  queueStorySync,
  readConflict,
  readSyncMeta,
  readSyncToken,
  recordConflict,
  rebaseSyncOutbox,
  toSyncConversation,
  withoutStorySync,
  type SyncOperation,
} from "../persistence/story-sync-repository";
import {
  deleteStorySession,
  listStorySessions,
  readStorySession,
  replaceStorySessionFromSync,
  writeStorySession,
} from "../persistence";
import { claimStoryLeaseToken, releaseStoryLeaseToken, renewStoryLeaseToken } from "../persistence";
import { subscribeDailyStorage, type DailyStorageEvent } from "../persistence";
import { pushSyncObject, pullSyncObjects, StorySyncApiError } from "./api";

export type StorySyncStatus = "disabled" | "syncing" | "synced" | "offline" | "error";
export type StorySyncSnapshot = { status: StorySyncStatus; message: string | null };

const SYNC_LEASE_ID = "__daily_story_sync__";
const SYNC_INTERVAL_MS = 60_000;
const SYNC_LEASE_RENEW_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 5 * 60_000] as const;

let snapshot: StorySyncSnapshot = { status: "disabled", message: null };
const listeners = new Set<(value: StorySyncSnapshot) => void>();
let runPromise: Promise<void> | null = null;

class SyncLeaseLostError extends Error {
  constructor() {
    super("同步标签页租约已失效，已停止本轮同步。");
    this.name = "SyncLeaseLostError";
  }
}

export function getStorySyncStatus() {
  return snapshot;
}

export function subscribeStorySync(listener: (value: StorySyncSnapshot) => void) {
  listeners.add(listener);
  listener(snapshot);
  return () => listeners.delete(listener);
}

function setStatus(status: StorySyncStatus, message: string | null = null) {
  snapshot = { status, message };
  listeners.forEach((listener) => listener(snapshot));
}

function retryAt(attempts: number) {
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)] ?? 5 * 60_000;
  return Date.now() + delay + Math.round(Math.random() * 250);
}

function sameWithoutLocalVersion(
  left: DailyStorySyncConversation,
  right: DailyStorySyncConversation,
) {
  const normalize = (value: DailyStorySyncConversation) => {
    const { revision: _revision, updatedAt: _updatedAt, ...rest } = value;
    return rest;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function isPrefix(prefix: readonly unknown[], value: readonly unknown[]) {
  return (
    prefix.length <= value.length &&
    prefix.every((item, index) => JSON.stringify(item) === JSON.stringify(value[index]))
  );
}

export function safeMerge(local: DailyStorySyncConversation, remote: DailyStorySyncConversation) {
  if (!local.sessionInstanceId || local.sessionInstanceId !== remote.sessionInstanceId) return null;
  const localMessages = local.messages;
  const remoteMessages = remote.messages;
  if (sameWithoutLocalVersion(local, remote)) return remote;
  if (!isPrefix(localMessages, remoteMessages) && !isPrefix(remoteMessages, localMessages))
    return null;
  const longer = remoteMessages.length >= localMessages.length ? remote : local;
  const localMeta = { ...local, messages: [] };
  const remoteMeta = { ...remote, messages: [] };
  if (
    JSON.stringify({ ...localMeta, revision: 0, updatedAt: "" }) !==
    JSON.stringify({ ...remoteMeta, revision: 0, updatedAt: "" })
  )
    return null;
  return longer;
}

async function reconcileLocalOutbox() {
  const outbox = await listSyncOutbox();
  const outboxIds = new Set(outbox.map((item) => item.conversationId));
  const sessions = await listStorySessions();
  for (const summary of sessions) {
    const meta = await readSyncMeta(summary.id);
    if (!outboxIds.has(summary.id) && meta?.localRevision !== summary.revision) {
      await queueStorySync(summary.id, "upsert");
    }
  }
}

async function applyRemoteObject(remote: DailyStorySyncRemoteObject) {
  await withoutStorySync(async () => {
    if (remote.deleted) {
      const current = await readStorySession(remote.conversationId);
      if (current) await deleteStorySession(remote.conversationId, current.revision);
      return;
    }
    if (!remote.payload) return;
    await replaceStorySessionFromSync(remote.conversationId, fromSyncConversation(remote.payload));
  });
  await markRemoteRevision(
    remote.conversationId,
    remote.remoteRevision,
    remote.payload?.revision ?? null,
    remote.payload?.sessionInstanceId,
  );
}

async function createConflictCopy(
  item: Awaited<ReturnType<typeof listSyncOutbox>>[number],
): Promise<string | null> {
  if (!item.payload) return null;
  const key = conflictKey(item.conversationId, item.mutationId);
  const existing = await readConflict(key);
  if (existing?.conflictConversationId) {
    const existingSession = await readStorySession(existing.conflictConversationId);
    const hasOutbox = (await listSyncOutbox()).some(
      (outbox) => outbox.conversationId === existing.conflictConversationId,
    );
    if (!existingSession) {
      const local = fromSyncConversation(item.payload);
      await writeStorySession(
        existing.conflictConversationId,
        {
          ...local,
          title: truncateConflictTitle(local.title ?? local.storyZh.slice(0, 36)),
        },
        null,
      );
    } else if (!hasOutbox) {
      await queueStorySync(existing.conflictConversationId, "upsert");
    }
    return existing.conflictConversationId;
  }
  const id = conflictConversationId(item.conversationId, item.mutationId);
  const local = fromSyncConversation(item.payload);
  await writeStorySession(
    id,
    { ...local, title: truncateConflictTitle(local.title ?? local.storyZh.slice(0, 36)) },
    null,
  );
  await recordConflict(key, item.conversationId, id, "upsert");
  return id;
}

export function truncateConflictTitle(title: string) {
  return Array.from(`冲突副本 · ${title}`).slice(0, 80).join("");
}

async function handleConflict(
  item: Awaited<ReturnType<typeof listSyncOutbox>>[number],
  error: StorySyncApiError,
) {
  const remote = error.remoteObject;
  if (!remote) {
    await rebaseSyncOutbox(item, null, item.payload);
    return;
  }
  if (item.operation === "delete") {
    if (remote.deleted) {
      await applyRemoteObject(remote);
      await dropSyncOutbox(item.conversationId, item.mutationId);
      return;
    }
    await recordConflict(
      conflictKey(item.conversationId, item.mutationId),
      item.conversationId,
      undefined,
      "delete",
    );
    await applyRemoteObject(remote);
    await dropSyncOutbox(item.conversationId, item.mutationId);
    return;
  }
  if (item.payload && remote.payload) {
    const merged = safeMerge(item.payload, remote.payload);
    if (merged) {
      await rebaseSyncOutbox(item, remote.remoteRevision, merged);
      return;
    }
  }
  await createConflictCopy(item);
  await applyRemoteObject(remote);
  await dropSyncOutbox(item.conversationId, item.mutationId);
}

async function pushPending(token: string, ensureLease: () => Promise<void>) {
  const items = await listSyncOutbox();
  for (const item of items) {
    if (item.nextAttemptAt > Date.now()) continue;
    try {
      await ensureLease();
      const remote = await pushSyncObject({
        token,
        conversationId: item.conversationId,
        mutationId: item.mutationId,
        expectedRemoteRevision: item.expectedRemoteRevision,
        conversation: item.payload,
      });
      await markSyncSuccess(item, remote.remoteRevision, item.payload?.revision ?? null);
    } catch (error) {
      if (error instanceof StorySyncApiError && error.code === "conflict") {
        await handleConflict(item, error);
        continue;
      }
      if (error instanceof SyncLeaseLostError) throw error;
      await markSyncAttempt(
        item,
        error instanceof Error ? error.message : "同步失败。",
        retryAt(item.attempts),
      );
      if (error instanceof StorySyncApiError && (error.status === 401 || error.status === 422))
        throw error;
    }
  }
}

async function pullAndApply(token: string, ensureLease: () => Promise<void>) {
  await ensureLease();
  const remoteObjects = await pullSyncObjects(token);
  const outbox = new Map((await listSyncOutbox()).map((item) => [item.conversationId, item]));
  for (const remote of remoteObjects) {
    if (outbox.has(remote.conversationId)) continue;
    const local = await readStorySession(remote.conversationId);
    const meta = await readSyncMeta(remote.conversationId);
    if (!local) {
      if (!remote.deleted) await applyRemoteObject(remote);
      else await markRemoteRevision(remote.conversationId, remote.remoteRevision, null);
      continue;
    }
    const localPayload = toSyncConversation(local, remote.conversationId);
    if (remote.payload && sameWithoutLocalVersion(localPayload, remote.payload)) {
      await markRemoteRevision(
        remote.conversationId,
        remote.remoteRevision,
        local.revision,
        local.sessionInstanceId,
      );
      continue;
    }
    if (meta?.remoteRevision === remote.remoteRevision) {
      await queueStorySync(remote.conversationId, "upsert");
      continue;
    }
    await applyRemoteObject(remote);
  }
}

export async function runDailyStorySync() {
  if (runPromise) return runPromise;
  runPromise = (async () => {
    let ownerId: string | undefined;
    let claimToken: string | null = null;
    let heartbeat: number | undefined;
    try {
      const token = await readSyncToken();
      if (!token) {
        setStatus("disabled");
        return;
      }
      setStatus("syncing");
      ownerId = createConversationId();
      claimToken = await claimStoryLeaseToken(SYNC_LEASE_ID, ownerId);
      if (!claimToken) {
        setStatus("synced", "其他标签页正在同步。");
        return;
      }
      let leaseLost = false;
      const renew = async () => {
        if (leaseLost || !ownerId || !claimToken) return;
        if (!(await renewStoryLeaseToken(SYNC_LEASE_ID, ownerId, claimToken))) leaseLost = true;
      };
      heartbeat = window.setInterval(() => {
        void renew().catch(() => {
          leaseLost = true;
        });
      }, SYNC_LEASE_RENEW_MS);
      const ensureLease = async () => {
        await renew();
        if (leaseLost) throw new SyncLeaseLostError();
      };
      await reconcileLocalOutbox();
      await pushPending(token, ensureLease);
      await pullAndApply(token, ensureLease);
      const remaining = (await listSyncOutbox()).some((item) => item.nextAttemptAt <= Date.now());
      const deleteConflicts = (await listSyncConflicts()).some(
        (conflict) => conflict.operation === "delete",
      );
      setStatus(
        remaining || deleteConflicts ? "error" : "synced",
        remaining
          ? "仍有对话等待同步。"
          : deleteConflicts
            ? "有一次删除与远端更新冲突；远端版本已保留，请确认后再删除。"
            : null,
      );
    } catch (error) {
      if (error instanceof SyncLeaseLostError) {
        setStatus("error", error.message);
      } else if (error instanceof StorySyncApiError && error.status === 401) {
        setStatus("error", "同步密钥无效，请在设置中重新输入。请保留本地对话。 ");
      } else if (error instanceof StorySyncApiError && (error.status === 0 || !navigator.onLine)) {
        setStatus("offline", "同步服务暂时不可用，本地功能不受影响。 ");
      } else {
        setStatus(
          "error",
          error instanceof Error ? error.message : "同步失败，本地功能不受影响。 ",
        );
      }
    } finally {
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      if (ownerId && claimToken) {
        await releaseStoryLeaseToken(SYNC_LEASE_ID, ownerId, claimToken);
      }
    }
  })().finally(() => {
    runPromise = null;
  });
  return runPromise;
}

export function startDailyStorySync() {
  let stopped = false;
  let timer: number | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void runDailyStorySync();
    }, 500);
  };
  const onStorage = (event: DailyStorageEvent) => {
    if (event.kind !== "session" || event.origin === "remote" || isStorySyncSuppressed()) return;
    void queueStorySync(event.conversationId)
      .then(schedule)
      .catch(() => setStatus("error", "本地同步队列写入失败。"));
  };
  const unsubscribe = subscribeDailyStorage(onStorage);
  const onWake = () => void runDailyStorySync();
  window.addEventListener("online", onWake);
  window.addEventListener("pageshow", onWake);
  const interval = window.setInterval(onWake, SYNC_INTERVAL_MS);
  void runDailyStorySync();
  return () => {
    stopped = true;
    unsubscribe();
    window.removeEventListener("online", onWake);
    window.removeEventListener("pageshow", onWake);
    window.clearInterval(interval);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
