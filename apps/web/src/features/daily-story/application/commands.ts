import type { DailyCapability, ProviderSettings, TurnSource } from "../types";
import type { DailyStoryTranscribeResult } from "../shared-types";

export type DailyStoryCommandDependencies = {
  start: () => Promise<void>;
  transcribe: (
    audio: Blob,
    readAloud?: boolean,
    durationSec?: number,
    fromCache?: boolean,
    readAloudTarget?: string,
    clientAttemptId?: string,
  ) => Promise<DailyStoryTranscribeResult>;
  send: (source: TurnSource, text: string) => Promise<boolean>;
  editTitle: (title: string) => boolean;
  finish: () => Promise<void>;
  cancelReview: () => void;
  newStory: () => Promise<void>;
  beginReadAloud: (target: string) => void;
  checkProvider: (
    capability: DailyCapability,
    provider: NonNullable<ProviderSettings[DailyCapability]>,
  ) => Promise<boolean>;
  retryCachedAudio: () => void;
  retry: () => void;
  playTts: (text: string) => void;
  saveAsrDraft: (text: string) => boolean;
  reRecord: () => void;
  beginRecording: () => void;
  recordingDraftReady: (readAloud?: boolean) => void;
  continueRecording: (readAloud?: boolean) => void;
  cancelRecording: () => void;
  resetReadAloud: () => void;
};

/** Product-facing command port. UI intent stays separate from controller plumbing. */
export function createDailyStoryCommands(deps: DailyStoryCommandDependencies) {
  return {
    start: deps.start,
    transcribe: deps.transcribe,
    send: (text: string, source: TurnSource = "typed") => deps.send(source, text),
    sendTyped: (text: string) => deps.send("typed", text),
    sendAsr: (text: string) => deps.send("asr", text),
    editTitle: deps.editTitle,
    finish: deps.finish,
    cancel: deps.cancelReview,
    beginReadAloud: deps.beginReadAloud,
    newStory: deps.newStory,
    checkProvider: deps.checkProvider,
    retryCachedAudio: deps.retryCachedAudio,
    retry: deps.retry,
    playTts: deps.playTts,
    saveAsrDraft: deps.saveAsrDraft,
    reRecord: deps.reRecord,
    beginRecording: deps.beginRecording,
    recordingDraftReady: deps.recordingDraftReady,
    continueRecording: deps.continueRecording,
    cancelRecording: deps.cancelRecording,
    resetReadAloud: deps.resetReadAloud,
  };
}

export type DailyStoryCommands = ReturnType<typeof createDailyStoryCommands>;
