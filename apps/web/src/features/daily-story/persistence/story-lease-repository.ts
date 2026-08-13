import { CURRENT, LEASE_MS, LEASE_STORE } from "./internal/database";
import { notifyLease, notifyLeaseReleased } from "./storage-events";
import { leaseSchema } from "./internal/schemas";
import { setResult, transaction } from "./internal/transaction";

export const LEASE_RETRY_DELAY_MS = LEASE_MS + 100;

export function acquireStoryLease(ownerId: string): Promise<boolean>;
export function acquireStoryLease(conversationId: string, ownerId: string): Promise<boolean>;
export async function acquireStoryLease(first: string, second?: string) {
  const conversationId = second === undefined ? CURRENT : first;
  const ownerId = second === undefined ? first : second;
  return (await claimStoryLeaseToken(conversationId, ownerId)) !== null;
}

/** Claim a new lease generation. A claim always receives a new fencing token. */
export async function claimStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  claimSequence?: number,
) {
  const claimToken = `${ownerId}:${crypto.randomUUID()}`;
  const claimed = await transaction<string | null>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      const now = Date.now();

      // A live lease owned by another controller cannot be taken over.
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        setResult(tx, null);
        return;
      }

      // A controller's strict local sequence prevents an older async load from
      // replacing a newer claim, regardless of wall-clock timestamp ties or
      // IndexedDB transaction completion order.
      if (
        lease?.ownerId === ownerId &&
        claimSequence !== undefined &&
        lease.claimSequence !== undefined &&
        claimSequence <= lease.claimSequence
      ) {
        setResult(tx, null);
        return;
      }

      const write = store.put({
        id: conversationId,
        ownerId,
        claimToken,
        ...(claimSequence !== undefined
          ? { claimSequence }
          : { claimSequence: (lease?.claimSequence ?? 0) + 1 }),
        expiresAt: now + LEASE_MS,
      });
      write.onsuccess = () => setResult(tx, claimToken);
    };
  });
  if (claimed) notifyLease(conversationId, ownerId);
  return claimed;
}

/** Claim the newest live connection. Older tabs become read-only. */
export async function claimStoryLease(conversationId: string, ownerId: string) {
  return (await claimStoryLeaseToken(conversationId, ownerId)) !== null;
}

/**
 * Renew the current lease generation.
 *
 * Renewal is deliberately not a claim: it requires the current owner and
 * fencing token, refuses an expired lease, and only extends the expiry.
 */
export async function renewStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  claimToken: string,
): Promise<boolean> {
  return transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      const now = Date.now();
      if (lease?.ownerId !== ownerId || lease.claimToken !== claimToken || lease.expiresAt <= now) {
        setResult(tx, false);
        return;
      }
      const write = store.put({ ...lease, expiresAt: now + LEASE_MS });
      write.onsuccess = () => setResult(tx, true);
    };
  });
}

/** Release only the exact lease generation held by the caller. */
export async function releaseStoryLeaseToken(
  conversationId: string,
  ownerId: string,
  claimToken: string,
) {
  const released = await transaction<boolean>(LEASE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(LEASE_STORE);
    const request = store.get(conversationId);
    request.onsuccess = () => {
      const record = request.result as unknown;
      const lease = record === undefined ? null : leaseSchema.parse(record);
      if (lease?.ownerId !== ownerId || lease.claimToken !== claimToken) {
        setResult(tx, false);
        return;
      }
      const deletion = store.delete(conversationId);
      deletion.onsuccess = () => setResult(tx, true);
    };
  });
  if (released) notifyLeaseReleased(conversationId, ownerId);
  return released;
}
