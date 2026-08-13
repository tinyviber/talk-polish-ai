import { describe, expect, test } from "vitest";
import type { DailyStoryAudioOutboxItem } from "./audio-outbox";
import { recoverCommittedStoryDeletion, splitDailyStoryAudio } from "./controller";
import { StorySidecarPersistenceError } from "./persistence/errors";

function makeAudio(
  clientAttemptId: string,
  purpose: DailyStoryAudioOutboxItem["purpose"],
): DailyStoryAudioOutboxItem {
  return {
    clientAttemptId,
    conversationId: "conversation-1",
    blob: new Blob([clientAttemptId], { type: "audio/webm" }),
    mimeType: "audio/webm",
    durationSec: 2,
    createdAt: Number(clientAttemptId),
    updatedAt: Number(clientAttemptId),
    status: "completed",
    purpose,
    ...(purpose === "readAloud" ? { readAloudTarget: "Try again." } : {}),
  };
}

describe("splitDailyStoryAudio", () => {
  test("keeps the latest all-purpose item for retry and filters read-aloud audio from the conversation list", () => {
    const conversation = makeAudio("1", "conversation");
    const readAloud = makeAudio("2", "readAloud");

    expect(splitDailyStoryAudio([conversation, readAloud])).toMatchObject({
      cachedAudio: {
        clientAttemptId: "2",
        purpose: "readAloud",
        readAloudTarget: "Try again.",
      },
      conversationAudios: [
        {
          clientAttemptId: "1",
          purpose: "conversation",
        },
      ],
    });
  });

  test("returns no audio when the outbox is empty", () => {
    expect(splitDailyStoryAudio([])).toEqual({
      cachedAudio: null,
      conversationAudios: [],
    });
  });
});

describe("committed Daily Story deletion recovery", () => {
  test("advances to a new story when primary deletion committed but sidecar cleanup failed", async () => {
    const warnings: unknown[][] = [];
    let signatureCleared = false;
    let dispatched = false;
    let storageWarning: string | null = null;

    await expect(
      recoverCommittedStoryDeletion(
        "conversation-1",
        new StorySidecarPersistenceError("conversation-1", "delete"),
        {
          readSession: async () => null,
          isCurrent: () => true,
          clearPersistenceSignature: () => {
            signatureCleared = true;
          },
          setStorageError: (message) => {
            storageWarning = message;
          },
          dispatchNewStory: () => {
            dispatched = true;
          },
          warn: (...args) => warnings.push(args),
        },
      ),
    ).resolves.toBe(true);

    expect(signatureCleared).toBe(true);
    expect(dispatched).toBe(true);
    expect(storageWarning).toBe("故事已删除，但复核缓存清理失败。系统会在后台继续清理。");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe("[daily-story sidecar cleanup pending]");
  });
});
