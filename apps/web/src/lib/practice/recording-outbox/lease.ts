export type OutboxLease = {
  learnerId: string;
  ownerId: string;
  expiresAt: number;
};

export function leaseIsActive(lease: OutboxLease | undefined, now = Date.now()) {
  return !!lease && lease.expiresAt > now;
}
