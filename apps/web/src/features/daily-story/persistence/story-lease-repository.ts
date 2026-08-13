import { CURRENT, LEASE_MS, LEASE_STORE } from "./internal/database";
import { notifyLease } from "./storage-events";
import { leaseSchema } from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";

export function acquireStoryLease(ownerId: string): Promise<boolean>;
export function acquireStoryLease(conversationId: string, ownerId: string): Promise<boolean>;
export async function acquireStoryLease(first: string, second?: string) {
  const conversationId = second === undefined ? CURRENT : first;
  const ownerId = second === undefined ? first : second;
  return (await acquireStoryLeaseToken(conversationId, ownerId)) !== null;
}

export async function acquireStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  expectedClaimToken?: string | null,
) {
  const claimToken = `${ownerId}:${crypto.randomUUID()}`;
  const claimStartedAt = Date.now();
  return transaction<string | null>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      const now = Date.now();
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        setResult(tx, null);
        return;
      }
      if (
        expectedClaimToken !== undefined &&
        (lease?.ownerId !== ownerId || lease.claimToken !== expectedClaimToken)
      ) {
        setResult(tx, null);
        return;
      }
      if (lease?.claimStartedAt !== undefined && claimStartedAt < lease.claimStartedAt) {
        setResult(tx, null);
        return;
      }
      const write = store.put({
        id: conversationId,
        ownerId,
        claimToken,
        claimStartedAt: Math.max(claimStartedAt, (lease?.claimStartedAt ?? 0) + 1),
        expiresAt: now + LEASE_MS,
      });
      write.onsuccess = () => setResult(tx, claimToken);
    };
  }).then((token) => {
    if (token) notifyLease(conversationId, ownerId);
    return token as string | null;
  });
}

/** Claim the newest live connection. Older tabs will become read-only. */
export async function claimStoryLease(conversationId: string, ownerId: string) {
  const claimToken = await claimStoryLeaseToken(conversationId, ownerId);
  return claimToken !== null;
}

/** Claim immediately; callers must do this before any load that can become stale. */
export async function claimStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  claimStartedAt?: number,
) {
  const claimToken = `${ownerId}:${crypto.randomUUID()}`;
  const claimed = await transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (
        claimStartedAt !== undefined &&
        lease?.claimStartedAt !== undefined &&
        claimStartedAt <= lease.claimStartedAt
      ) {
        setResult(tx, false);
        return;
      }
      const write = store.put({
        id: conversationId,
        ownerId,
        claimToken,
        claimStartedAt: Math.max(claimStartedAt ?? Date.now(), (lease?.claimStartedAt ?? 0) + 1),
        expiresAt: Date.now() + LEASE_MS,
      });
      write.onsuccess = () => setResult(tx, true);
    };
  });
  if (claimed) notifyLease(conversationId, ownerId);
  return claimed ? claimToken : null;
}

export async function releaseStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  claimToken: string,
) {
  return transaction<void>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (lease?.ownerId !== ownerId || lease.claimToken !== claimToken) {
        setResult(tx, undefined);
        return;
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  });
}

export function releaseStoryLease(ownerId: string): Promise<void>;
export function releaseStoryLease(conversationId: string, ownerId: string): Promise<void>;
export async function releaseStoryLease(first: string, second?: string) {
  const conversationId = second === undefined ? CURRENT : first;
  const ownerId = second === undefined ? first : second;
  return transaction<void>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (lease?.ownerId !== ownerId) {
        setResult(tx, undefined);
        return;
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, undefined);
    };
  });
}
