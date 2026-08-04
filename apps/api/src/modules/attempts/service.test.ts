import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PROMPTS, fixtureFeedback, type Attempt } from "@kotoba/contracts";
import { ApiError } from "../../http/errors";

const prompt = PROMPTS[0]!;
const learnerId = "lnr_test";
const sessionId = "ses_test";
const audio = {
  buffer: Buffer.from("test-audio"),
  mimeType: "audio/webm",
  filename: "answer.webm",
};

type StorageCleanupCall = {
  storageKey: string;
  reason: string;
};

type State = {
  cleanupCalls: StorageCleanupCall[];
  storagePutCalls: string[];
  transcribeCalls: number;
  assessCalls: number;
  persistCalls: number;
  rateLimitCalls: number;
  storagePut: (key: string) => Promise<{ storageKey: string }>;
  requirePrompt: typeof prompt | (() => Promise<typeof prompt>);
  getAttempt: (id: string) => Promise<Attempt>;
  findSession: (id: string) => Promise<{ id: string; learnerId: string; promptId: string } | null>;
  findByClientId: (learnerId: string, clientAttemptId: string) => Promise<any>;
  findBySessionAndIndex: (sessionId: string, attemptIndex: 1 | 2) => Promise<any>;
  markFailedIfProcessing: (attemptId: string) => Promise<boolean>;
  insertProcessing: (
    input: any,
  ) => Promise<{ audioId: string | null; reclaimedStorageKeys: string[] }>;
  findRaced: (learnerId: string, clientAttemptId: string) => Promise<any>;
  persistResult: (input: any) => Promise<void>;
  removeAttempt: (attemptId: string, audioId: string | null) => Promise<void>;
  markFailed: (attemptId: string) => Promise<void>;
  removeAudioMetadata: (audioId: string) => Promise<void>;
};

const state: State = {
  cleanupCalls: [],
  storagePutCalls: [],
  transcribeCalls: 0,
  assessCalls: 0,
  persistCalls: 0,
  rateLimitCalls: 0,
  storagePut: async (key) => ({ storageKey: key }),
  requirePrompt: prompt,
  getAttempt: async (id) => createReadyAttempt(id),
  findSession: async (id) => ({ id, learnerId, promptId: prompt.id }),
  findByClientId: async () => undefined,
  findBySessionAndIndex: async () => undefined,
  markFailedIfProcessing: async () => false,
  insertProcessing: async () => ({ audioId: "aud_test", reclaimedStorageKeys: [] }),
  findRaced: async () => undefined,
  persistResult: async () => {
    state.persistCalls += 1;
  },
  removeAttempt: async () => {},
  markFailed: async () => {},
  removeAudioMetadata: async () => {},
};

mock.module("../../providers", () => ({
  providers: () => ({
    storage: {
      name: "test-storage",
      put: async ({ key }: { key: string }) => {
        state.storagePutCalls.push(key);
        return state.storagePut(key);
      },
      get: async () => null,
      remove: async () => {},
    },
    transcription: {
      name: "test-transcription",
      transcribe: async () => {
        state.transcribeCalls += 1;
        return {
          text: "Recovered transcript",
          provider: "test-transcription",
          mocked: false,
          transcription: null,
        };
      },
    },
    assessment: {
      name: "test-assessment",
      assess: async () => {
        state.assessCalls += 1;
        return {
          provider: "test-assessment",
          feedback: fixtureFeedback(prompt.id, prompt.lang, 1),
        };
      },
    },
    tts: {
      name: "test-tts",
      synthesize: async () => ({ mimeType: "audio/mpeg", storageKey: null }),
    },
    realtime: {
      enabled: false,
      smokeTest: async () => {},
      createSession: async () => {
        throw new Error("not implemented");
      },
    },
  }),
}));

mock.module("../sessions/service", () => ({
  getAttempt: async (id: string) => state.getAttempt(id),
}));

mock.module("../prompts/service", () => ({
  requirePrompt: async () =>
    typeof state.requirePrompt === "function" ? state.requirePrompt() : state.requirePrompt,
}));

mock.module("../providers/rate-limit", () => ({
  enforceProviderRateLimit: () => {
    state.rateLimitCalls += 1;
  },
}));

mock.module("../../db/storage-cleanup", () => ({
  removeOrQueueStorage: async (_storage: unknown, storageKey: string, reason: string) => {
    state.cleanupCalls.push({ storageKey, reason });
  },
}));

mock.module("./repository", () => ({
  attemptRepository: {
    findSession: (id: string) => state.findSession(id),
    findByClientId: (currentLearnerId: string, clientAttemptId: string) =>
      state.findByClientId(currentLearnerId, clientAttemptId),
    findBySessionAndIndex: (currentSessionId: string, attemptIndex: 1 | 2) =>
      state.findBySessionAndIndex(currentSessionId, attemptIndex),
    markFailedIfProcessing: (attemptId: string) => state.markFailedIfProcessing(attemptId),
    insertProcessing: (input: any) => state.insertProcessing(input),
    findRaced: (currentLearnerId: string, clientAttemptId: string) =>
      state.findRaced(currentLearnerId, clientAttemptId),
    persistResult: (input: any) => state.persistResult(input),
    removeAttempt: (attemptId: string, audioId: string | null) =>
      state.removeAttempt(attemptId, audioId),
    markFailed: (attemptId: string) => state.markFailed(attemptId),
    removeAudioMetadata: (audioId: string) => state.removeAudioMetadata(audioId),
  },
}));

const { ATTEMPT_PROCESSING_STALE_MS, createAttempt } = await import("./service");

beforeEach(() => {
  state.cleanupCalls = [];
  state.storagePutCalls = [];
  state.transcribeCalls = 0;
  state.assessCalls = 0;
  state.persistCalls = 0;
  state.rateLimitCalls = 0;
  state.storagePut = async (key) => ({ storageKey: key });
  state.requirePrompt = prompt;
  state.getAttempt = async (id) => createReadyAttempt(id);
  state.findSession = async (id) => ({ id, learnerId, promptId: prompt.id });
  state.findByClientId = async () => undefined;
  state.findBySessionAndIndex = async () => undefined;
  state.markFailedIfProcessing = async () => false;
  state.insertProcessing = async () => ({ audioId: "aud_test", reclaimedStorageKeys: [] });
  state.findRaced = async () => undefined;
  state.persistResult = async () => {
    state.persistCalls += 1;
  };
  state.removeAttempt = async () => {};
  state.markFailed = async () => {};
  state.removeAudioMetadata = async () => {};
});

describe("attempt recovery", () => {
  test("fails stale processing slots before starting new provider work", async () => {
    const staleAttempt = {
      id: "att_stale",
      sessionId,
      attemptIndex: 1,
      status: "processing",
      clientAttemptId: null,
      createdAt: new Date(Date.now() - ATTEMPT_PROCESSING_STALE_MS - 1),
    };
    let markedAttemptId: string | undefined;
    state.findBySessionAndIndex = async () => staleAttempt;
    state.markFailedIfProcessing = async (attemptId) => {
      markedAttemptId = attemptId;
      return true;
    };

    await expect(
      createAttempt(
        sessionId,
        learnerId,
        { attemptIndex: 1, durationSec: 12, mocked: false },
        audio,
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "processing_unavailable",
      message: expect.stringContaining("Please retry the upload."),
    });

    expect(markedAttemptId).toBe("att_stale");
    expect(state.rateLimitCalls).toBe(0);
    expect(state.storagePutCalls).toHaveLength(0);
    expect(state.transcribeCalls).toBe(0);
    expect(state.assessCalls).toBe(0);
    expect(state.persistCalls).toBe(0);
    expect(state.cleanupCalls).toHaveLength(0);
  });

  test("deduplicates concurrent retries after a failed slot becomes reclaimable", async () => {
    const failedAttempt = {
      id: "att_failed",
      sessionId,
      attemptIndex: 1,
      status: "failed",
      clientAttemptId: "client-retry-1234",
      createdAt: new Date(),
    };
    let winnerAttemptId = "";
    let insertCalls = 0;
    let releaseWinner: (() => void) | null = null;
    const winnerPaused = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    state.findByClientId = async () => failedAttempt;
    state.findBySessionAndIndex = async () => failedAttempt;
    state.storagePut = async (key) => ({ storageKey: `stored:${key}` });
    state.insertProcessing = async (input) => {
      insertCalls += 1;
      if (insertCalls === 1) {
        winnerAttemptId = input.attemptId;
        await winnerPaused;
        return { audioId: "aud_winner", reclaimedStorageKeys: ["stale-storage-key"] };
      }
      releaseWinner?.();
      throw ApiError.conflict("That resource already exists.");
    };
    state.findRaced = async () => ({
      id: winnerAttemptId,
      sessionId,
      attemptIndex: 1,
    });
    state.getAttempt = async (id) => createReadyAttempt(id);

    const first = createAttempt(
      sessionId,
      learnerId,
      {
        attemptIndex: 1,
        durationSec: 12,
        clientAttemptId: failedAttempt.clientAttemptId,
        mocked: false,
      },
      audio,
    );
    const second = createAttempt(
      sessionId,
      learnerId,
      {
        attemptIndex: 1,
        durationSec: 12,
        clientAttemptId: failedAttempt.clientAttemptId,
        mocked: false,
      },
      audio,
    );
    const [winner, replay] = await Promise.all([first, second]);

    expect(winner.id).toBe(winnerAttemptId);
    expect(replay.id).toBe(winnerAttemptId);
    expect(state.rateLimitCalls).toBe(2);
    expect(state.storagePutCalls).toHaveLength(2);
    expect(state.transcribeCalls).toBe(1);
    expect(state.assessCalls).toBe(1);
    expect(state.persistCalls).toBe(1);
    expect(state.cleanupCalls).toHaveLength(2);
    expect(state.cleanupCalls).toContainEqual({
      storageKey: "stale-storage-key",
      reason: "reclaimed-attempt",
    });
    expect(
      state.cleanupCalls.some(
        (call) =>
          call.reason === "idempotent-retry" &&
          call.storageKey.startsWith("stored:recordings/lnr_test/att_") &&
          call.storageKey.endsWith(".webm"),
      ),
    ).toBe(true);
  });
});

function createReadyAttempt(id: string): Attempt {
  return {
    id,
    clientAttemptId: "client-retry-1234",
    sessionId,
    index: 1,
    status: "ready",
    transcript: "Recovered transcript",
    feedback: fixtureFeedback(prompt.id, prompt.lang, 1),
    durationSec: 12,
    mocked: false,
    audio: {
      id: "aud_ready",
      mimeType: "audio/webm",
      sizeBytes: audio.buffer.byteLength,
      durationSec: 12,
      playbackUrl: "/api/audio/recordings/aud_ready",
    },
    createdAt: new Date().toISOString(),
  };
}
