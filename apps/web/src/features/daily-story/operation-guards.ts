/**
 * Identity carried by an asynchronous Daily Story operation.
 *
 * The token is intentionally independent of React, AbortController, and
 * browser APIs. A token is current only while its operation is still the
 * latest operation in the same generation and settings revision.
 */
export type OperationToken = Readonly<{
  generation: number;
  id: number;
  settingsRevision: number;
}>;

export type OperationGuard = Readonly<{
  /** Starts and marks a new operation as current. */
  begin(settingsRevision: number): OperationToken;
  /** Invalidates the current operation and advances the lifecycle generation. */
  invalidate(): void;
  /** Returns the current lifecycle generation. */
  generation(): number;
  /** Reports whether a token can still publish its result. */
  isCurrent(token: OperationToken): boolean;
}>;

/**
 * Creates a guard for async work whose completion must match the latest
 * operation, lifecycle generation, and provider-settings revision.
 */
export function createOperationGuard(): OperationGuard {
  let currentGeneration = 0;
  let nextOperationId = 0;
  let currentToken: OperationToken | null = null;

  return {
    begin(settingsRevision) {
      const token: OperationToken = {
        generation: currentGeneration,
        id: ++nextOperationId,
        settingsRevision,
      };
      currentToken = token;
      return token;
    },

    invalidate() {
      currentGeneration += 1;
      currentToken = null;
    },

    generation() {
      return currentGeneration;
    },

    isCurrent(token) {
      return (
        currentToken?.generation === token.generation &&
        currentToken.id === token.id &&
        currentToken.settingsRevision === token.settingsRevision
      );
    },
  };
}

export type SequenceGate = Readonly<{
  /** Starts a newer sequence and returns its sequence number. */
  begin(): number;
  /** Reports whether a sequence is still the latest one begun. */
  isCurrent(sequence: number): boolean;
}>;

/**
 * Creates a latest-wins gate for independent load, persistence, or event
 * streams. Create one gate per stream; beginning a sequence supersedes all
 * earlier sequences in that gate.
 */
export function createSequenceGate(): SequenceGate {
  let latestSequence = 0;

  return {
    begin() {
      latestSequence += 1;
      return latestSequence;
    },

    isCurrent(sequence) {
      return sequence === latestSequence;
    },
  };
}
