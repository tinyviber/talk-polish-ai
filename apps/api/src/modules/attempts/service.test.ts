import { beforeEach, describe, expect, mock, test } from "bun:test";
import { MAX_AUDIO_BYTES, PROMPTS, fixtureFeedback, type Attempt } from "@kotoba/contracts";
import { ApiError } from "../../http/errors";
import { attemptRepository } from "./repository";

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

type AttemptLookupRow = Awaited<ReturnType<typeof attemptRepository.findByClientId>>;
type AttemptRaceRow = Awaited<ReturnType<typeof attemptRepository.findRaced>>;
type InsertProcessingInput = Parameters<typeof attemptRepository.insertProcessing>[0];
type PersistResultInput = Parameters<typeof attemptRepository.persistResult>[0];

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
  findByClientId: (learnerId: string, clientAttemptId: string) => Promise<AttemptLookupRow>;
  findBySessionAndIndex: (sessionId: string, attemptIndex: 1 | 2) => Promise<AttemptLookupRow>;
  markFailedIfProcessing: (attemptId: string) => Promise<boolean>;
  insertProcessing: (
    input: InsertProcessingInput,
  ) => Promise<{ audioId: string | null; reclaimedStorageKeys: string[] }>;
  findRaced: (learnerId: string, clientAttemptId: string) => Promise<AttemptRaceRow>;
  persistResult: (input: PersistResultInput) => Promise<void>;
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
    insertProcessing: (input: InsertProcessingInput) => state.insertProcessing(input),
    findRaced: (currentLearnerId: string, clientAttemptId: string) =>
      state.findRaced(currentLearnerId, clientAttemptId),
    persistResult: (input: PersistResultInput) => state.persistResult(input),
    removeAttempt: (attemptId: string, audioId: string | null) =>
      state.removeAttempt(attemptId, audioId),
    markFailed: (attemptId: string) => state.markFailed(attemptId),
    removeAudioMetadata: (audioId: string) => state.removeAudioMetadata(audioId),
  },
}));

const { ATTEMPT_PROCESSING_STALE_MS, createAttempt, createAttemptApplication } =
  await import("./service");
const { providers } = await import("../../providers");

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
  test("uses the runtime upload limit while keeping the compatibility default", async () => {
    const configuredMaxBytes = MAX_AUDIO_BYTES + 1;
    const audioOverDefaultLimit = { ...audio, buffer: Buffer.alloc(configuredMaxBytes) };
    const fields = { attemptIndex: 1 as const, durationSec: 12, mocked: false };

    await expect(
      createAttempt(sessionId, learnerId, fields, audioOverDefaultLimit),
    ).rejects.toMatchObject({ code: "payload_too_large" });

    await expect(
      createAttemptApplication(providers(), configuredMaxBytes).createAttempt(
        sessionId,
        learnerId,
        fields,
        audioOverDefaultLimit,
      ),
    ).resolves.toMatchObject({ status: "ready" });
  });

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

  test("preserves attempt and audio when result commit status is unknown", async () => {
    let resultReadCount = 0;
    state.persistResult = async () => {
      state.persistCalls += 1;
      throw ApiError.database("The result acknowledgement was lost.");
    };
    state.getAttempt = async (id) => {
      resultReadCount += 1;
      if (resultReadCount === 1)
        throw ApiError.database("The database is temporarily unavailable.");
      return createReadyAttempt(id);
    };

    await expect(
      createAttempt(
        sessionId,
        learnerId,
        {
          attemptIndex: 1,
          durationSec: 12,
          clientAttemptId: "client-commit-unknown",
          mocked: false,
        },
        audio,
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "processing_unavailable",
      message: expect.stringContaining("same recording"),
    });

    expect(state.cleanupCalls).toHaveLength(0);

    state.findByClientId = async () => ({
      id: "att_committed",
      sessionId,
      attemptIndex: 1,
      status: "ready",
      clientAttemptId: "client-commit-unknown",
      createdAt: new Date(),
    });
    const recovered = await createAttempt(
      sessionId,
      learnerId,
      {
        attemptIndex: 1,
        durationSec: 12,
        clientAttemptId: "client-commit-unknown",
        mocked: false,
      },
      audio,
    );
    expect(recovered.id).toBe("att_committed");
    expect(state.persistCalls).toBe(1);
  });

  test("reclaims a rolled-back processing row before retrying the same recording", async () => {
    const clientAttemptId = "client-rolled-back";
    const staleRow = {
      id: "att-rolled-back",
      sessionId,
      attemptIndex: 1 as const,
      status: "processing",
      clientAttemptId,
      createdAt: new Date(Date.now() - ATTEMPT_PROCESSING_STALE_MS - 1),
    };
    let lookupRow: AttemptLookupRow = undefined;
    let markedAttemptId: string | undefined;
    let persistError = true;
    state.findByClientId = async () => lookupRow;
    state.getAttempt = async (id) =>
      persistError
        ? {
            ...createReadyAttempt(id),
            status: "processing",
            transcript: null,
            feedback: null,
            audio: null,
          }
        : createReadyAttempt(id);
    state.markFailedIfProcessing = async (attemptId) => {
      markedAttemptId = attemptId;
      lookupRow = { ...staleRow, status: "failed" };
      return true;
    };
    state.persistResult = async () => {
      state.persistCalls += 1;
      if (persistError) throw ApiError.database("The result transaction rolled back.");
    };

    // The first request inserted processing, but its result transaction rolled
    // back and its acknowledgement was lost. The caller only knows 503.
    await expect(
      createAttempt(
        sessionId,
        learnerId,
        { attemptIndex: 1, durationSec: 12, clientAttemptId, mocked: false },
        audio,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "processing_unavailable" });

    lookupRow = staleRow;
    await expect(
      createAttempt(
        sessionId,
        learnerId,
        { attemptIndex: 1, durationSec: 12, clientAttemptId, mocked: false },
        audio,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "processing_unavailable" });
    expect(markedAttemptId).toBe(staleRow.id);

    persistError = false;
    await expect(
      createAttempt(
        sessionId,
        learnerId,
        { attemptIndex: 1, durationSec: 12, clientAttemptId, mocked: false },
        audio,
      ),
    ).resolves.toMatchObject({ status: "ready" });
    expect(state.persistCalls).toBe(2);
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
