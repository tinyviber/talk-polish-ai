import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  deferNextFakeIndexedDbTransaction,
  installFakeIndexedDb,
} from "@/lib/practice/test/fakeIndexedDb";
import { getLeaseProtectedMutationToken } from "./controller";
import { DailyStoryCoordinator } from "./coordinator";
import {
  claimStoryLeaseToken,
  deleteStorySession,
  readStorySession,
  releaseStoryLeaseToken,
  writeStorySession,
} from "./persistence";
import { subscribeDailyStorage } from "./persistence";
import { SessionConflictError } from "./persistence/errors";
import { __resetDailyStorageForTests } from "./persistence/testing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function activeCoordinator() {
  const coordinator = new DailyStoryCoordinator();
  coordinator.activate();
  coordinator.setCanEdit(true);
  coordinator.setSettingsRevision(1);
  return coordinator;
}

describe("Daily Story coordinator race guards", () => {
  test("a newer load sequence wins after a deferred completion", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const firstLoad = coordinator.beginLoad();
    const firstCompletion = pending.promise.then(() => coordinator.isLoadCurrent(firstLoad));
    const secondLoad = coordinator.beginLoad();

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(coordinator.isLoadCurrent(secondLoad)).toBe(true);
  });

  test("an immediate pagehide/pageshow gets a newer editable load sequence", () => {
    const coordinator = activeCoordinator();
    const initial = coordinator.beginLoad(true);
    coordinator.deactivate();
    coordinator.activate();
    const restored = coordinator.beginLoad(true);

    expect(restored.sequence).toBeGreaterThan(initial.sequence);
    expect(restored.claimLease).toBe(true);
    expect(coordinator.isLoadCurrent(restored)).toBe(true);
  });

  test("a reconcile load is read-only and never requests a lease claim", () => {
    const coordinator = activeCoordinator();
    const initialLoad = coordinator.beginLoad(true);
    const reconcileLoad = coordinator.beginLoad(false);

    expect(initialLoad.claimLease).toBe(true);
    expect(reconcileLoad.claimLease).toBe(false);
    expect(coordinator.canEdit).toBe(true);
    expect(coordinator.isLoadCurrent(reconcileLoad)).toBe(true);
  });

  test("a newer write sequence makes an older deferred write stale", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const firstWrite = coordinator.beginWrite();
    const firstCompletion = pending.promise.then(() => coordinator.isWriteCurrent(firstWrite));
    const secondWrite = coordinator.beginWrite();

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(coordinator.isWriteSequenceCurrent(secondWrite)).toBe(true);
    expect(coordinator.isWriteCurrent(secondWrite)).toBe(true);
  });

  test("a newer operation makes an older deferred completion stale", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const firstOperation = coordinator.beginOperation();
    const firstCompletion = pending.promise.then(() =>
      coordinator.isOperationCurrent(firstOperation),
    );
    const secondOperation = coordinator.beginOperation();

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(coordinator.isOperationCurrent(secondOperation)).toBe(true);
  });

  test("reconcile loads do not claim and provider checks use an independent lane", async () => {
    const coordinator = activeCoordinator();
    const operation = coordinator.beginOperation();
    const firstCheck = coordinator.beginProviderCheck();
    const pending = deferred<void>();
    const firstCompletion = pending.promise.then(() =>
      coordinator.isProviderCheckCurrent(firstCheck),
    );
    const secondCheck = coordinator.beginProviderCheck();
    const reconcile = coordinator.beginLoad(false);

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(reconcile.claimLease).toBe(false);
    expect(coordinator.isProviderCheckCurrent(secondCheck)).toBe(true);
    expect(coordinator.isOperationCurrent(operation)).toBe(true);
  });

  test("audio and settings refreshes are latest-wins sequences", () => {
    const coordinator = activeCoordinator();
    const oldAudio = coordinator.beginAudioRefresh();
    const newAudio = coordinator.beginAudioRefresh();
    const oldSettings = coordinator.beginSettingsRead();
    const newSettings = coordinator.beginSettingsRead();

    expect(coordinator.isAudioRefreshCurrent(oldAudio)).toBe(false);
    expect(coordinator.isAudioRefreshCurrent(newAudio)).toBe(true);
    expect(coordinator.isSettingsReadCurrent(oldSettings)).toBe(false);
    expect(coordinator.isSettingsReadCurrent(newSettings)).toBe(true);
  });

  test("a newer cached-audio refresh makes an older deferred result stale", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const firstRefresh = coordinator.beginAudioRefresh();
    const firstCompletion = pending.promise.then(() =>
      coordinator.isAudioRefreshCurrent(firstRefresh),
    );
    const secondRefresh = coordinator.beginAudioRefresh();

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(coordinator.isAudioRefreshCurrent(secondRefresh)).toBe(true);
  });

  test("a newer provider check makes an older deferred result stale", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const firstCheck = coordinator.beginProviderCheck(1);
    const firstCompletion = pending.promise.then(() =>
      coordinator.isProviderCheckCurrent(firstCheck),
    );
    const secondCheck = coordinator.beginProviderCheck(1);

    pending.resolve();

    await expect(firstCompletion).resolves.toBe(false);
    expect(coordinator.isProviderCheckCurrent(secondCheck)).toBe(true);
  });

  test("a settings revision invalidates provider checks without sharing the chat lane", () => {
    const coordinator = activeCoordinator();
    const providerCheck = coordinator.beginProviderCheck(1);
    const chatOperation = coordinator.beginOperation(1);

    expect(coordinator.isProviderCheckCurrent(providerCheck)).toBe(true);
    expect(coordinator.isOperationCurrent(chatOperation)).toBe(true);

    const nextProviderCheck = coordinator.beginProviderCheck(1);

    expect(coordinator.isProviderCheckCurrent(providerCheck)).toBe(false);
    expect(coordinator.isProviderCheckCurrent(nextProviderCheck)).toBe(true);
    expect(coordinator.isOperationCurrent(chatOperation)).toBe(true);

    coordinator.setSettingsRevision(2);

    expect(coordinator.isProviderCheckCurrent(nextProviderCheck)).toBe(false);
    expect(coordinator.isOperationCurrent(chatOperation)).toBe(false);
    const nextChatOperation = coordinator.beginOperation(2);
    expect(coordinator.isOperationCurrent(nextChatOperation)).toBe(true);
  });

  test("pagehide deactivates every pending load, write, and operation", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const load = coordinator.beginLoad();
    const write = coordinator.beginWrite();
    const operation = coordinator.beginOperation();
    const audioRefresh = coordinator.beginAudioRefresh();
    const settingsRead = coordinator.beginSettingsRead();
    const providerCheck = coordinator.beginProviderCheck();
    const completion = pending.promise.then(() => ({
      load: coordinator.isLoadCurrent(load),
      write: coordinator.isWriteCurrent(write),
      operation: coordinator.isOperationCurrent(operation),
      audioRefresh: coordinator.isAudioRefreshCurrent(audioRefresh),
      settingsRead: coordinator.isSettingsReadCurrent(settingsRead),
      providerCheck: coordinator.isProviderCheckCurrent(providerCheck),
    }));

    coordinator.deactivate();
    pending.resolve();

    await expect(completion).resolves.toEqual({
      load: false,
      write: false,
      operation: false,
      audioRefresh: false,
      settingsRead: false,
      providerCheck: false,
    });
    expect(coordinator.canEdit).toBe(false);
    expect(coordinator.isPageActive()).toBe(false);
  });

  test("losing the lease makes pending writes stale and reacquisition starts cleanly", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const oldWrite = coordinator.beginWrite();
    const oldCompletion = pending.promise.then(() => coordinator.isWriteCurrent(oldWrite));

    coordinator.setCanEdit(false);
    pending.resolve();

    await expect(oldCompletion).resolves.toBe(false);
    coordinator.setCanEdit(true);
    const newWrite = coordinator.beginWrite();
    expect(coordinator.isWriteCurrent(newWrite)).toBe(true);
  });

  test("losing the lease invalidates provider checks and blocks new operations", () => {
    const coordinator = activeCoordinator();
    const oldOperation = coordinator.beginOperation();
    const oldCheck = coordinator.beginProviderCheck();

    coordinator.setCanEdit(false);

    expect(coordinator.isOperationCurrent(oldOperation)).toBe(false);
    expect(coordinator.isProviderCheckCurrent(oldCheck)).toBe(false);
    expect(coordinator.isPageActive()).toBe(true);
  });

  test("a new page lifecycle cannot publish tokens from the previous lifecycle", () => {
    const coordinator = activeCoordinator();
    const oldOperation = coordinator.beginOperation();
    const oldRefresh = coordinator.beginAudioRefresh();

    coordinator.deactivate();
    coordinator.activate();
    coordinator.setCanEdit(true);

    expect(coordinator.isOperationCurrent(oldOperation)).toBe(false);
    expect(coordinator.isAudioRefreshCurrent(oldRefresh)).toBe(false);
    expect(coordinator.isOperationCurrent(coordinator.beginOperation())).toBe(true);
  });

  test("a settings revision change invalidates old operation and write completions", async () => {
    const coordinator = activeCoordinator();
    const pending = deferred<void>();
    const oldOperation = coordinator.beginOperation();
    const oldWrite = coordinator.beginWrite();
    const completion = pending.promise.then(() => ({
      operation: coordinator.isOperationCurrent(oldOperation),
      write: coordinator.isWriteCurrent(oldWrite),
    }));

    coordinator.setSettingsRevision(2);
    pending.resolve();

    await expect(completion).resolves.toEqual({ operation: false, write: false });
    expect(coordinator.isOperationCurrent(coordinator.beginOperation())).toBe(true);
    expect(coordinator.isWriteCurrent(coordinator.beginWrite())).toBe(true);
  });
});

describe("Daily Story controller lease handoff", () => {
  let restore: () => void;

  beforeAll(() => {
    restore = installFakeIndexedDb();
  });

  beforeEach(async () => {
    await __resetDailyStorageForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("kotoba-loop-settings");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("kotoba-daily-story-review-v2");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await __resetDailyStorageForTests();
  });

  afterAll(() => restore());

  test("pagehide/reclaim fences old T1 write and delete tokens", async () => {
    const conversationId = "conversation-controller-lease-handoff";
    const coordinator = activeCoordinator();
    const saved = await writeStorySession(
      conversationId,
      { phase: "chatting", storyZh: "今天下雨", messages: [] },
      null,
    );
    const tokenT1 = await claimStoryLeaseToken(conversationId, "owner", 1_000);
    expect(tokenT1).toBeTruthy();
    const oldWrite = coordinator.beginWrite();

    coordinator.deactivate();
    await releaseStoryLeaseToken(conversationId, "owner", tokenT1!);
    expect(coordinator.isWriteCurrent(oldWrite)).toBe(false);
    expect(getLeaseProtectedMutationToken(true, coordinator.isPageActive(), tokenT1)).toBeNull();

    coordinator.activate();
    coordinator.setCanEdit(true);
    const tokenT2 = await claimStoryLeaseToken(conversationId, "owner", 2_000);
    expect(tokenT2).toBeTruthy();
    expect(tokenT2).not.toBe(tokenT1);
    expect(
      getLeaseProtectedMutationToken(coordinator.canEdit, coordinator.isPageActive(), tokenT2),
    ).toBe(tokenT2);

    await expect(
      writeStorySession(
        conversationId,
        { phase: "chatting", storyZh: "旧 T1 写入", messages: [] },
        saved.revision,
        "owner",
        tokenT1!,
      ),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(
      deleteStorySession(conversationId, saved.revision, "owner", tokenT1!),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(readStorySession(conversationId)).resolves.toMatchObject({
      revision: saved.revision,
      storyZh: "今天下雨",
    });

    await deleteStorySession(conversationId, saved.revision, "owner", tokenT2!);
    await releaseStoryLeaseToken(conversationId, "owner", tokenT2!);
  });

  test("release notification lets a rejected remount claim without stale release damage", async () => {
    const conversationId = "conversation-fast-remount-release";
    const tokenA = await claimStoryLeaseToken(conversationId, "owner-a", 1);
    expect(tokenA).toBeTruthy();

    let editable = false;
    let tokenB: string | null = null;
    const acquired = new Promise<void>((resolve) => {
      const unsubscribe = subscribeDailyStorage((event) => {
        if (event.kind !== "leaseReleased" || event.conversationId !== conversationId) return;
        void claimStoryLeaseToken(conversationId, "owner-b", 1).then((token) => {
          tokenB = token;
          editable = token !== null;
          unsubscribe();
          resolve();
        });
      });
    });

    const releaseGate = deferNextFakeIndexedDbTransaction();
    const releaseA = releaseStoryLeaseToken(conversationId, "owner-a", tokenA!);
    await expect(claimStoryLeaseToken(conversationId, "owner-b", 1)).resolves.toBeNull();

    releaseGate.release();
    await expect(releaseA).resolves.toBe(true);
    await acquired;

    expect(editable).toBe(true);
    expect(tokenB).toBeTruthy();
    // A stale continuation cannot release the new generation.
    await expect(releaseStoryLeaseToken(conversationId, "owner-a", tokenA!)).resolves.toBe(false);
    await expect(claimStoryLeaseToken(conversationId, "owner-c", 1)).resolves.toBeNull();
    await releaseStoryLeaseToken(conversationId, "owner-b", tokenB!);
  });

  test("an expired live lease can be reclaimed by the next load", async () => {
    const conversationId = "conversation-expired-remount";
    const tokenA = await claimStoryLeaseToken(conversationId, "owner-a", 1);
    expect(tokenA).toBeTruthy();
    await mutateRawLeaseForRace(conversationId, {
      ownerId: "owner-a",
      claimToken: tokenA!,
      claimSequence: 1,
      expiresAt: Date.now() - 1,
    });

    const tokenB = await claimStoryLeaseToken(conversationId, "owner-b", 1);
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);
    await releaseStoryLeaseToken(conversationId, "owner-b", tokenB!);
  });
});

async function mutateRawLeaseForRace(
  conversationId: string,
  lease: { ownerId: string; claimToken: string; claimSequence: number; expiresAt: number },
) {
  const request = indexedDB.open("kotoba-loop-settings", 2);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("storyLeases", "readwrite");
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.objectStore("storyLeases").put({ id: conversationId, ...lease });
  });
}
