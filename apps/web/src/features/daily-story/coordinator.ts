import { createOperationGuard, createSequenceGate, type OperationToken } from "./operation-guards";

/**
 * React-free lifecycle and async-work coordinator for Daily Story.
 *
 * It owns the mutable values that asynchronous controller continuations use
 * to decide whether they may still publish a result. It deliberately has no
 * knowledge of React, browser storage, or the Daily Story API.
 */
export class DailyStoryCoordinator {
  private readonly operationGuard = createOperationGuard();
  private readonly providerCheckGuard = createOperationGuard();
  private readonly loadSequenceGate = createSequenceGate();
  private readonly writeSequenceGate = createSequenceGate();
  private readonly audioRefreshSequenceGate = createSequenceGate();
  private readonly settingsReadSequenceGate = createSequenceGate();
  private readonly writeSettingsRevisions = new Map<number, number>();
  private mounted = false;
  private pageActive = true;
  private editable = false;
  private currentSettingsRevision = 0;

  get canEdit() {
    return this.editable;
  }

  get settingsRevision() {
    return this.currentSettingsRevision;
  }

  activate() {
    this.mounted = true;
    this.pageActive = true;
  }

  deactivate() {
    this.mounted = false;
    this.pageActive = false;
    this.editable = false;
    this.invalidate();
    this.providerCheckGuard.invalidate();
    this.loadSequenceGate.begin();
    this.writeSequenceGate.begin();
    this.audioRefreshSequenceGate.begin();
    this.settingsReadSequenceGate.begin();
  }

  setCanEdit(canEdit: boolean) {
    const lostLease = this.editable && !canEdit;
    this.editable = canEdit;
    if (lostLease) {
      this.invalidate();
      this.providerCheckGuard.invalidate();
    }
  }

  setSettingsRevision(settingsRevision: number) {
    if (settingsRevision <= this.currentSettingsRevision) return false;
    this.currentSettingsRevision = settingsRevision;
    // Provider checks are independent from chat/TTS, but a settings revision
    // change makes an in-flight check's answer unusable.
    this.providerCheckGuard.invalidate();
    return true;
  }

  invalidate() {
    this.operationGuard.invalidate();
  }

  generation() {
    return this.operationGuard.generation();
  }

  isPageActive() {
    return this.mounted && this.pageActive;
  }

  beginOperation(settingsRevision = this.currentSettingsRevision) {
    return this.operationGuard.begin(settingsRevision);
  }

  isOperationCurrent(token: OperationToken) {
    return (
      this.isPageActive() &&
      this.editable &&
      this.currentSettingsRevision === token.settingsRevision &&
      this.operationGuard.isCurrent(token)
    );
  }

  beginLoad(claimLease = true): LoadToken {
    return { sequence: this.loadSequenceGate.begin(), claimLease };
  }

  isLoadCurrent(load: LoadToken | number) {
    const sequence = typeof load === "number" ? load : load.sequence;
    return this.isPageActive() && this.loadSequenceGate.isCurrent(sequence);
  }

  beginAudioRefresh() {
    return this.audioRefreshSequenceGate.begin();
  }

  isAudioRefreshCurrent(sequence: number) {
    return this.isPageActive() && this.audioRefreshSequenceGate.isCurrent(sequence);
  }

  beginSettingsRead() {
    return this.settingsReadSequenceGate.begin();
  }

  isSettingsReadCurrent(sequence: number) {
    return this.isPageActive() && this.settingsReadSequenceGate.isCurrent(sequence);
  }

  beginWrite() {
    const sequence = this.writeSequenceGate.begin();
    this.writeSettingsRevisions.set(sequence, this.currentSettingsRevision);
    return sequence;
  }

  isWriteSequenceCurrent(sequence: number) {
    return (
      this.isPageActive() &&
      this.writeSequenceGate.isCurrent(sequence) &&
      this.writeSettingsRevisions.get(sequence) === this.currentSettingsRevision
    );
  }

  isWriteCurrent(sequence: number) {
    return this.isWriteSequenceCurrent(sequence) && this.editable;
  }

  beginProviderCheck(settingsRevision = this.currentSettingsRevision) {
    return this.providerCheckGuard.begin(settingsRevision);
  }

  isProviderCheckCurrent(token: OperationToken) {
    return (
      this.isPageActive() &&
      this.editable &&
      this.currentSettingsRevision === token.settingsRevision &&
      this.providerCheckGuard.isCurrent(token)
    );
  }
}

export type LoadToken = Readonly<{
  sequence: number;
  claimLease: boolean;
}>;
export type { OperationToken } from "./operation-guards";
