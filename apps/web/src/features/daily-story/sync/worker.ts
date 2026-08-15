import type { DailyStorySyncConversation, DailyStorySyncRemoteObject } from "@kotoba/contracts";
import { createConversationId, createId, type StorySession } from "../types";
import {
  conflictConversationIdForPayload,
  conflictKey,
  createConflictCopyInTransaction,
  dropSyncOutbox,
  fromSyncConversation,
  hashSyncPayload,
  listSyncOutbox,
  listSyncConflicts,
  listSyncMeta,
  markRemoteRevision,
  markSyncAttempt,
  markSyncSuccess,
  readConflict,
  readSyncMeta,
  readSyncToken,
  refreshSyncOutboxPayload,
  recordConflict,
  rebaseSyncOutbox,
  toSyncConversation,
} from "../persistence/story-sync-repository";
import {
  applyRemoteStoryDeletion,
  applyRemoteStorySession,
  readStorySession,
  reconcileStorySyncOutbox,
  repairStoryReviewFromSync,
} from "../persistence";
import { claimStoryLeaseToken, releaseStoryLeaseToken, renewStoryLeaseToken } from "../persistence";
import { subscribeDailyStorage, type DailyStorageEvent } from "../persistence";
import { pushSyncObject, pullSyncObjects, StorySyncApiError } from "./api";

export type StorySyncStatus = "disabled" | "syncing" | "synced" | "pending" | "offline" | "error";
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
  await reconcileStorySyncOutbox();
}

async function repairPendingReviews() {
  const metas = await listSyncMeta();
  for (const meta of metas) {
    if (!meta.reviewRepair) continue;
    try {
      await repairStoryReviewFromSync(meta.conversationId, meta.reviewRepair);
    } catch {
      // Keep the marker. A later scheduled run retries the sidecar repair.
    }
  }
}

async function applyRemoteObject(remote: DailyStorySyncRemoteObject) {
  const current = await readStorySession(remote.conversationId);
  if (remote.deleted) {
    return applyRemoteStoryDeletion(
      remote.conversationId,
      remote.remoteRevision,
      current?.revision ?? null,
    );
  }
  if (!remote.payload) return "skipped" as const;
  return applyRemoteStorySession(
    remote.conversationId,
    fromSyncConversation(remote.payload),
    remote.remoteRevision,
    current?.revision ?? null,
  );
}

async function createConflictCopy(
  item: Awaited<ReturnType<typeof listSyncOutbox>>[number],
): Promise<string | null> {
  if (!item.payload) return null;
  const key = conflictKey(item.conversationId, item.mutationId);
  const payloadHash = await hashSyncPayload(item.payload);
  const existing = await readConflict(key);
  let id =
    existing?.conflictConversationId ??
    (await conflictConversationIdForPayload(item.conversationId, item.payload));
  let existingSession = await readStorySession(id);
  if (existing?.payloadHash && existing.payloadHash !== payloadHash) {
    id = await conflictConversationIdForPayload(item.conversationId, item.payload);
    existingSession = await readStorySession(id);
  } else if (existingSession && !existing?.payloadHash) {
    const normalize = (value: DailyStorySyncConversation, conversationId: string) => {
      const {
        conversationId: _id,
        revision: _revision,
        updatedAt: _updatedAt,
        sessionInstanceId: _instance,
        ...rest
      } = value;
      return { ...rest, conversationId };
    };
    const existingPayload = toSyncConversation(existingSession, item.conversationId);
    if (
      JSON.stringify(normalize(existingPayload, item.conversationId)) !==
      JSON.stringify(normalize(item.payload, item.conversationId))
    ) {
      id = await conflictConversationIdForPayload(item.conversationId, item.payload);
      existingSession = await readStorySession(id);
    }
  }
  const local = fromSyncConversation(item.payload);
  const copy =
    existingSession ??
    ({
      ...local,
      revision: 1,
      sessionInstanceId: createId("session"),
      updatedAt: new Date().toISOString(),
      title: truncateConflictTitle(local.title ?? local.storyZh.slice(0, 36)),
    } satisfies StorySession);
  let copyResult = await createConflictCopyInTransaction(
    key,
    item.conversationId,
    id,
    payloadHash,
    copy,
  );
  if (copyResult === "collision") {
    const baseId = await conflictConversationIdForPayload(item.conversationId, item.payload);
    for (let suffix = 2; suffix <= 9 && copyResult === "collision"; suffix += 1) {
      id = `${baseId.slice(0, 156)}_${suffix}`;
      const candidate = await readStorySession(id);
      copyResult = await createConflictCopyInTransaction(
        key,
        item.conversationId,
        id,
        payloadHash,
        candidate ?? copy,
      );
    }
    if (copyResult === "collision") throw new Error("无法创建安全的冲突副本。");
  }
  const marker = await readSyncMeta(id);
  if (marker?.reviewRepair) await repairStoryReviewFromSync(id, marker.reviewRepair);
  await refreshSyncOutboxPayload(id);
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
      await dropSyncOutbox(item.conversationId, item.mutationId);
      await applyRemoteObject(remote);
      return;
    }
    await recordConflict(
      conflictKey(item.conversationId, item.mutationId),
      item.conversationId,
      undefined,
      "delete",
    );
    await dropSyncOutbox(item.conversationId, item.mutationId);
    await applyRemoteObject(remote);
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
  await dropSyncOutbox(item.conversationId, item.mutationId);
  await applyRemoteObject(remote);
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
  for (const remote of remoteObjects) {
    await ensureLease();
    // Re-read immediately before each apply. A user mutation may have been
    // committed after the page-level pull started.
    if ((await listSyncOutbox()).some((item) => item.conversationId === remote.conversationId))
      continue;
    const local = await readStorySession(remote.conversationId);
    const meta = await readSyncMeta(remote.conversationId);
    if (!local) {
      await applyRemoteObject(remote);
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
      await reconcileLocalOutbox();
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
        setStatus("syncing", "其他标签页正在同步。");
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
      await repairPendingReviews();
      await reconcileLocalOutbox();
      await pushPending(token, ensureLease);
      await pullAndApply(token, ensureLease);
      await repairPendingReviews();
      const remaining = (await listSyncOutbox()).length > 0;
      const pendingRepair = (await listSyncMeta()).some((meta) => meta.reviewRepair);
      const openConflicts = (await listSyncConflicts()).filter(
        (conflict) => conflict.status === "open",
      );
      const deleteConflicts = openConflicts.some((conflict) => conflict.operation === "delete");
      setStatus(
        openConflicts.length > 0 || pendingRepair ? "error" : remaining ? "pending" : "synced",
        openConflicts.length > 0
          ? deleteConflicts
            ? "有一次删除与远端更新冲突；远端版本已保留，请确认后再删除。"
            : "发现冲突副本；远端和本地版本都已保留。"
          : pendingRepair
            ? "review 本地修复未完成，将自动重试。"
            : remaining
              ? "仍有对话等待同步。"
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
    if (event.kind === "session") schedule();
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
