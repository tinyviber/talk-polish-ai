import { describe, expect, test, vi } from "vitest";
import { createDailyStoryCommands } from "./commands";

describe("Daily Story application commands", () => {
  test("maps product intents to controller ports", async () => {
    const calls: string[] = [];
    const commands = createDailyStoryCommands({
      start: async () => {
        calls.push("start");
      },
      transcribe: async () => ({
        succeeded: true,
        clientAttemptId: "a1",
        transcript: "hello",
        transcriptId: "t1",
      }),
      send: async (source, text) => {
        calls.push(`${source}:${text}`);
        return true;
      },
      editTitle: (title) => {
        calls.push(`title:${title}`);
        return true;
      },
      finish: async () => {
        calls.push("finish");
      },
      cancelReview: () => calls.push("cancel"),
      newStory: async () => {
        calls.push("new");
      },
      beginReadAloud: (target) => calls.push(`read:${target}`),
      checkProvider: vi.fn(async () => true),
      retryCachedAudio: () => calls.push("retry"),
      retry: () => calls.push("retry-review"),
      playTts: (text) => calls.push(`tts:${text}`),
      saveAsrDraft: (text) => {
        calls.push(`draft:${text}`);
        return true;
      },
      reRecord: () => calls.push("re-record"),
      beginRecording: () => calls.push("record"),
      recordingDraftReady: () => calls.push("draft-ready"),
      continueRecording: () => calls.push("continue-recording"),
      cancelRecording: () => calls.push("cancel-recording"),
      resetReadAloud: () => calls.push("reset-read-aloud"),
    });

    await commands.start();
    await commands.send("typed text");
    await commands.send("spoken text", "asr");
    await expect(commands.sendAsr("spoken again")).resolves.toBe(true);
    await commands.finish();
    commands.cancel();
    commands.beginReadAloud("a1");
    await commands.newStory();
    commands.retryCachedAudio();
    expect(commands.editTitle("新标题")).toBe(true);

    expect(calls).toEqual([
      "start",
      "typed:typed text",
      "asr:spoken text",
      "asr:spoken again",
      "finish",
      "cancel",
      "read:a1",
      "new",
      "retry",
      "title:新标题",
    ]);
  });
});
