import { describe, expect, test } from "vitest";
import type { DailyStoryAudioOutboxItem } from "./audio-outbox";
import { splitDailyStoryAudio } from "./controller";

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
