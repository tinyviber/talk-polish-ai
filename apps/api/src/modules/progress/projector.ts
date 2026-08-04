import type { AttemptReadyEvent } from "../attempts/domain/events";

export interface ProgressProjector {
  project(event: AttemptReadyEvent): Promise<void>;
}

export function createProgressProjector(
  write: (event: AttemptReadyEvent) => Promise<void>,
): ProgressProjector {
  return { project: write };
}
