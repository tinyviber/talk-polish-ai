/**
 * React adapter boundary for Daily Story application orchestration.
 *
 * The implementation remains in controller.ts during this migration so the
 * first cut changes ownership/imports without changing behavior. New UI code
 * should consume useDailyStory; controller is compatibility-only afterward.
 */
import { createDailyStoryCommands, type DailyStoryCommands } from "./commands";
import { useDailyStoryController } from "../controller";

export function useDailyStory(conversationId: string, allowCompose = false) {
  const story = useDailyStoryController(conversationId, allowCompose);
  const commands: DailyStoryCommands = createDailyStoryCommands({
    start: story.start,
    transcribe: story.transcribe,
    send: (source, text) => (source === "asr" ? story.sendAsr(text) : story.sendTyped(text)),
    finish: story.finish,
    cancelReview: story.cancelReview,
    newStory: story.newStory,
    beginReadAloud: story.beginReadAloud,
    checkProvider: story.checkProvider,
    retryCachedAudio: story.retryCachedAudio,
    retry: story.retry,
    playTts: story.playTts,
    saveAsrDraft: story.saveAsrDraft,
    reRecord: story.reRecord,
    beginRecording: story.beginRecording,
    recordingDraftReady: story.recordingDraftReady,
    continueRecording: story.continueRecording,
    cancelRecording: story.cancelRecording,
    resetReadAloud: story.resetReadAloud,
  });
  return { ...story, commands };
}

export { useDailyStoryController } from "../controller";

export type { DailyStoryCachedAudio, DailyStoryTranscribeResult } from "../shared-types";
