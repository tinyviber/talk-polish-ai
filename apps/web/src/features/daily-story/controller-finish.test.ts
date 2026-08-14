import { describe, expect, test, vi } from "vitest";

type TestReview = {
  score: number | null;
  comment: string | null;
  rubric: null;
  suggestions: [];
};

type TestState = {
  phase: "chatting" | "reviewing" | "review";
  storyZh: string;
  title: string | null;
  messages: Array<{ id: string; role: "assistant" | "user"; text: string }>;
  review: TestReview | null;
  operation: { id: string; settingsRevision: number } | null;
  settingsRevision: number;
};

type TestAction =
  | { type: "reviewRequest"; operationId: string; settingsRevision: number }
  | {
      type: "reviewSuccess";
      operationId: string;
      settingsRevision: number;
      review: TestReview;
      title?: string;
    };

type TestCoordinator = {
  canEdit: boolean;
  settingsRevision: number;
  invalidate: () => void;
};

const harness = vi.hoisted(() => {
  class FakeCoordinator implements TestCoordinator {
    canEdit = true;
    settingsRevision = 1;
    private active = true;
    private generationValue = 0;
    private operationSequence = 0;
    private currentOperation: { id: string; settingsRevision: number; generation: number } | null =
      null;

    activate() {
      this.active = true;
    }

    deactivate() {
      this.active = false;
      this.invalidate();
    }

    isPageActive() {
      return this.active;
    }

    setCanEdit(value: boolean) {
      this.canEdit = value;
      if (!value) this.invalidate();
    }

    setSettingsRevision(value: number) {
      this.settingsRevision = value;
    }

    generation() {
      return this.generationValue;
    }

    invalidate() {
      this.generationValue += 1;
      this.currentOperation = null;
    }

    beginOperation(settingsRevision = this.settingsRevision) {
      const token = {
        id: `review-${++this.operationSequence}`,
        settingsRevision,
        generation: this.generationValue,
      };
      this.currentOperation = token;
      return token;
    }

    isOperationCurrent(token: { id: string; settingsRevision: number; generation: number }) {
      return (
        this.active &&
        this.canEdit &&
        token === this.currentOperation &&
        token.generation === this.generationValue &&
        token.settingsRevision === this.settingsRevision
      );
    }

    beginSettingsRead() {
      return { generation: this.generationValue };
    }

    isSettingsReadCurrent(token: { generation: number }) {
      return token.generation === this.generationValue;
    }
  }

  return {
    initial: null as TestState | null,
    state: null as TestState | null,
    coordinator: null as TestCoordinator | null,
    FakeCoordinator,
    reviewDailyStory: vi.fn(),
  };
});

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useReducer: (
    reducer: (state: TestState, action: TestAction) => TestState,
    initial: TestState,
  ) => {
    const state = structuredClone(harness.initial ?? initial);
    harness.state = state;
    const dispatch = (action: TestAction) => {
      const next = reducer(state, action);
      if (next !== state) Object.assign(state, next);
    };
    return [state, dispatch];
  },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, () => undefined],
}));

vi.mock("@/lib/pwa", () => ({ usePwa: () => ({ setBusy: vi.fn() }) }));
vi.mock("./api", () => ({
  checkDailyProvider: vi.fn(),
  replyDailyStory: vi.fn(),
  reviewDailyStory: harness.reviewDailyStory,
  startDailyStory: vi.fn(),
  synthesizeDailyStory: vi.fn(),
  transcribeDailyStory: vi.fn(),
  isDailyStoryAbortError: () => false,
}));
vi.mock("./persistence", () => ({
  LEASE_RETRY_DELAY_MS: 1,
  SessionConflictError: class SessionConflictError extends Error {},
  StorySidecarPersistenceError: class StorySidecarPersistenceError extends Error {},
  claimStoryLeaseToken: vi.fn(),
  deleteStorySession: vi.fn(),
  ensureDailyStorage: vi.fn(),
  readProviderSettings: vi.fn(async () => ({
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-08-14T00:00:00.000Z",
    chat: { baseUrl: "https://example.com/v1", apiKey: "test-key", model: "test-model" },
  })),
  readStorySession: vi.fn(),
  releaseStoryLeaseToken: vi.fn(),
  renewStoryLeaseToken: vi.fn(),
  subscribeDailyStorage: vi.fn(() => () => undefined),
  writeStorySession: vi.fn(),
}));
vi.mock("./state-machine", () => ({
  initialDailyState: {
    phase: "loading",
    draft: "",
    storyZh: "",
    title: null,
    messages: [],
    pendingTranscript: null,
    review: null,
    revision: null,
    settingsRevision: 0,
    operation: null,
    error: null,
    readAloudTranscript: null,
    readAloudTarget: null,
  },
  isDailyBusy: (phase: string) => phase === "reviewing" || phase === "starting",
  snapshotDailyState: () => null,
  dailyReducer: (state: TestState, action: TestAction) => {
    if (action.type === "reviewRequest") {
      state.phase = "reviewing";
      state.operation = { id: action.operationId, settingsRevision: action.settingsRevision };
    }
    if (action.type === "reviewSuccess") {
      state.phase = "review";
      state.operation = null;
      state.review = action.review;
      if (state.title === null && action.title) state.title = action.title;
    }
    return state;
  },
}));
vi.mock("./coordinator", () => ({
  DailyStoryCoordinator: class extends harness.FakeCoordinator {
    constructor() {
      super();
      harness.coordinator = this;
    }
  },
}));
vi.mock("./audio-outbox", () => ({
  get: vi.fn(),
  list: vi.fn(async () => []),
  put: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./single-flight", () => ({
  runSingleFlight: vi.fn((_ref: unknown, task: () => unknown) => task()),
}));
vi.mock("./controller-helpers", () => ({
  isDailyStoryCachedAudioRetryCurrent: vi.fn(),
  isDailyStoryPageActive: vi.fn(),
  splitDailyStoryAudio: () => ({ cachedAudio: null, conversationAudios: [] }),
}));
vi.mock("./tts-playback", () => ({ releaseTransientTtsPlayback: vi.fn() }));
vi.mock("@kotoba/contracts", () => ({
  DAILY_STORY_LIMITS: { turnChars: 4_000 },
  deriveStableDailyStoryTitle: (storyZh: string) => storyZh.slice(0, 8),
}));

import { useDailyStoryController } from "./controller";

function ControllerTestHarness(initial: TestState) {
  harness.initial = initial;
  harness.state = null;
  harness.coordinator = null;
  harness.reviewDailyStory.mockReset();
  return {
    hook: useDailyStoryController("conversation-p2"),
    reviewDailyStory: harness.reviewDailyStory,
    get state() {
      return harness.state!;
    },
    get coordinator() {
      return harness.coordinator!;
    },
  };
}

function initialState(title: string | null): TestState {
  return {
    phase: "chatting",
    storyZh: "今天学校开会",
    title,
    messages: [
      { id: "assistant-1", role: "assistant", text: "Tell me more." },
      { id: "user-1", role: "user", text: "I stayed home." },
    ],
    review: {
      score: 72,
      comment: "继续保持。",
      rubric: null,
      suggestions: [],
    },
    operation: null,
    settingsRevision: 1,
  };
}

const generatedReview = {
  score: 88,
  comment: "表达清楚。",
  rubric: null,
  suggestions: [],
};

describe("Daily Story controller re-review title behavior", () => {
  test("does not request or replace a persisted stable title", async () => {
    const mounted = ControllerTestHarness(initialState("稳定标题"));
    mounted.reviewDailyStory.mockResolvedValue({ review: generatedReview, title: "模型新标题" });

    await mounted.hook.finish();

    expect(mounted.reviewDailyStory).toHaveBeenCalledOnce();
    expect(mounted.reviewDailyStory).toHaveBeenCalledWith(
      expect.objectContaining({ includeTitle: false }),
    );
    expect(mounted.state.title).toBe("稳定标题");
    expect(mounted.state.review).toEqual(generatedReview);
  });

  test("requests missing title in same review call and commits it", async () => {
    const mounted = ControllerTestHarness(initialState(null));
    mounted.reviewDailyStory.mockResolvedValue({ review: generatedReview, title: "学校会议" });

    await mounted.hook.finish();

    expect(mounted.reviewDailyStory).toHaveBeenCalledOnce();
    expect(mounted.reviewDailyStory).toHaveBeenCalledWith(
      expect.objectContaining({ includeTitle: true }),
    );
    expect(mounted.state.title).toBe("学校会议");
    expect(mounted.state.review).toEqual(generatedReview);
  });

  test("does not commit stale review or title after operation invalidation", async () => {
    const mounted = ControllerTestHarness(initialState(null));
    let resolveReview!: (value: unknown) => void;
    mounted.reviewDailyStory.mockReturnValue(
      new Promise((resolve) => {
        resolveReview = resolve;
      }),
    );

    const finish = mounted.hook.finish();
    await vi.waitFor(() => expect(mounted.reviewDailyStory).toHaveBeenCalledOnce());
    mounted.coordinator.invalidate();
    resolveReview({ review: generatedReview, title: "过期标题" });
    await finish;

    expect(mounted.state.title).toBeNull();
    expect(mounted.state.review).toMatchObject({ score: 72, comment: "继续保持。" });
    expect(mounted.state.phase).toBe("reviewing");
  });
});
