import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AppHeader } from "@/components/practice/AppHeader";
import { PromptCard } from "@/components/practice/PromptCard";
import { RecordControls } from "@/components/practice/RecordControls";
import { TranscriptView } from "@/components/practice/TranscriptView";
import { ImprovementCard } from "@/components/practice/ImprovementCard";
import { ExpressionRow } from "@/components/practice/ExpressionRow";
import { ScoreBar, ScoreDial } from "@/components/practice/ScoreDial";
import { usePracticeStore, todayIso } from "@/lib/practice/store";
import { useRecorder, type RecorderDraft } from "@/lib/practice/useRecorder";
import { analyzeAttempt } from "@/lib/practice/mockServices";
import {
  ApiClientError,
  createSession,
  getAttempt,
  getQueueLearnerId,
  getQueueLearnerIds,
  uploadQueuedAttempt,
} from "@/lib/practice/api";
import {
  enqueueRecording,
  listRecordingQueue,
  markFeedbackDelivered,
  markFeedbackError,
  retryQueuedRecordings,
  subscribeRecordingQueue,
  syncRecordingQueue,
  type RecordingQueueItem,
} from "@/lib/practice/offlineQueue";
import { usePwa } from "@/lib/pwa";
import type { Attempt, ScoreKey } from "@/lib/practice/types";
import { cn } from "@/lib/utils";
import { findReadyRecording, loadReadyAttempt } from "@/features/practice/ready-attempt";
import {
  initialPracticeState,
  reducePracticeState,
  type PracticeStage,
} from "@/features/practice/state-machine";
import {
  abandonWorkflow,
  listRecoveryWorkflows,
  type DurablePracticeWorkflow,
} from "@/lib/practice/workflow-store";
import {
  hydratePracticeWorkflow,
  queueIdentityForAttempt,
  selectFrozenPrompt,
  type FrozenPracticeContext,
} from "@/lib/practice/workflow-context";
import { FeedbackRecovery } from "@/features/practice/components/FeedbackRecovery";

export const Route = createFileRoute("/practice")({
  head: () => ({
    meta: [
      { title: "Speaking practice — Kotoba Loop" },
      {
        name: "description",
        content: "Answer a realistic prompt out loud, get focused coaching, then try again better.",
      },
      { property: "og:title", content: "Speaking practice — Kotoba Loop" },
      {
        property: "og:description",
        content: "Answer a realistic prompt out loud, get focused coaching, then try again better.",
      },
    ],
  }),
  component: Practice,
});

type Step = PracticeStage;

const STEP_INDEX: Record<Step, number> = {
  prompt: 1,
  record: 1,
  recording: 1,
  recorded: 1,
  uploading: 2,
  processing: 2,
  feedback: 2,
  "feedback-recovery": 2,
  record2: 3,
  processing2: 3,
  result: 4,
  "offline-recovery": 2,
  retry: 2,
};

const STEP_LABELS = ["Prompt", "Feedback", "Second take", "Result"];

function errorMessage(error: unknown) {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Something went wrong. Please try again.";
}

/** Network-level failures are recoverable offline; API 4xx/5xx are not. */
function isOfflineFailure(error: unknown) {
  return (
    (error instanceof ApiClientError && error.status === 0) ||
    (typeof navigator !== "undefined" && !navigator.onLine)
  );
}

function Stepper({ step }: { step: Step }) {
  const active = STEP_INDEX[step];
  return (
    <ol className="flex items-center gap-2" aria-label="Session progress">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const state = n < active ? "done" : n === active ? "current" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                state === "done" && "bg-success text-success-foreground",
                state === "current" && "bg-primary text-primary-foreground",
                state === "todo" && "bg-secondary text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3.5" aria-hidden /> : n}
            </span>
            <span
              className={cn(
                "hidden text-xs font-medium sm:inline",
                state === "todo" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {label}
            </span>
            {n < STEP_LABELS.length ? <span className="h-px flex-1 bg-border" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Processing({ label }: { label: string }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-10 text-center shadow-lift">
      <Loader2 className="mx-auto size-8 animate-spin text-primary" aria-hidden />
      <p className="mt-4 font-display text-lg" aria-live="polite">
        {label}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Transcribing · scoring · picking your top fixes
      </p>
    </div>
  );
}

function Practice() {
  const {
    ready,
    state,
    mode,
    prompts,
    error: storeError,
    toggleSaved,
    isSaved,
    recordSession,
    refresh,
    switchToDemo,
  } = usePracticeStore();
  const [practiceState, dispatchPractice] = useReducer(reducePracticeState, initialPracticeState);
  const step = practiceState.stage;
  const [first, setFirst] = useState<Attempt | null>(null);
  const [second, setSecond] = useState<Attempt | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    mode === "demo" ? `s-${Date.now()}` : null,
  );
  const [promptOffset, setPromptOffset] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interruptedDraftPending, setInterruptedDraftPending] = useState(false);
  const [feedbackRetryPending, setFeedbackRetryPending] = useState(false);
  const [feedbackPendingDelivery, setFeedbackPendingDelivery] = useState<string | null>(null);
  const [recoveryTarget, setRecoveryTarget] = useState<DurablePracticeWorkflow | null>(null);
  // Once a session starts, prompt/language identity must not follow the
  // mutable store. This is also the context restored after a cold start.
  const [frozenContext, setFrozenContext] = useState<FrozenPracticeContext | null>(null);
  const { setBusy } = usePwa();
  const interruptedAttemptIdRef = useRef<string | null>(null);
  const pendingFeedbackAttemptIdRef = useRef<string | null>(null);
  const readyAttemptResolutionRef = useRef(new Map<string, Promise<Attempt | null>>());
  const workflowGenerationRef = useRef(0);
  const queueReadGenerationRef = useRef(0);
  const queueMountedRef = useRef(false);
  // Generated when a session starts so recordings captured with no network can
  // still be attached to one practice session once the device reconnects.
  const clientSessionIdRef = useRef<string | null>(null);

  const lang = frozenContext?.lang ?? state.lang ?? "en";
  const languagePrompts = useMemo(
    () => prompts.filter((prompt) => prompt.lang === lang),
    [lang, prompts],
  );
  // Frozen at mount so the prompt never changes mid-session when a session is recorded.
  const [baseIndex] = useState(() => state.sessions.filter((s) => s.lang === lang).length);
  const prompt = selectFrozenPrompt(
    prompts,
    frozenContext,
    languagePrompts[(baseIndex + promptOffset) % Math.max(1, languagePrompts.length)] ?? null,
  );
  const jp = lang === "ja";
  const hydrateWorkflowContext = useCallback((workflow: DurablePracticeWorkflow) => {
    const context = hydratePracticeWorkflow(workflow);
    clientSessionIdRef.current = workflow.clientSessionId;
    setFrozenContext(context);
    setSessionId(workflow.sessionId);
  }, []);
  const saveInterruptedDraft = useCallback(
    async (draft: RecorderDraft) => {
      if (mode !== "api" || !prompt) return;
      const clientSessionId = clientSessionIdRef.current;
      if (!clientSessionId) return;
      const attemptIndex: 1 | 2 = step === "record2" ? 2 : 1;
      const identity = frozenContext
        ? queueIdentityForAttempt(frozenContext, attemptIndex)
        : { clientSessionId, promptId: prompt.id, lang, attemptIndex };
      const learnerId = getQueueLearnerId();
      const clientAttemptId = interruptedAttemptIdRef.current ?? crypto.randomUUID();
      interruptedAttemptIdRef.current = clientAttemptId;
      // Keep this separate from recorder.status: the latter becomes recorded
      // before the asynchronous IndexedDB write finishes.
      setBusy(true, "draft-save");
      try {
        await enqueueRecording(
          {
            learnerId,
            clientAttemptId,
            sessionId,
            clientSessionId: identity.clientSessionId,
            promptId: identity.promptId,
            lang: identity.lang,
            attemptIndex: identity.attemptIndex,
            duration: draft.durationSec,
            mimeType: draft.mimeType,
            blob: draft.blob,
            createdAt: Date.now(),
          },
          getQueueLearnerIds(),
        );
        setInterruptedDraftPending(true);
        setError(
          "Your interrupted recording was saved on this device and will upload when you reconnect.",
        );
      } finally {
        setBusy(false, "draft-save");
      }
    },
    [frozenContext, lang, mode, prompt, sessionId, setBusy, step],
  );
  const recorder = useRecorder({ mode, onInterruptedRecording: saveInterruptedDraft });
  const [queuedItems, setQueuedItems] = useState<RecordingQueueItem[]>([]);

  useEffect(() => {
    if (recorder.status === "recording") dispatchPractice({ type: "recording" });
    if (recorder.status === "recorded") dispatchPractice({ type: "recorded" });
  }, [recorder.status]);

  const resolveReadyAttempt = useCallback(
    async (item: RecordingQueueItem, generation = workflowGenerationRef.current) => {
      const resolutionKey = `${item.clientAttemptId}:${generation}`;
      const existing = readyAttemptResolutionRef.current.get(resolutionKey);
      if (existing) return existing;
      const resolution = (async () => {
        const result = await loadReadyAttempt(item, getAttempt);
        if (!result) return null;
        const activeTarget = interruptedAttemptIdRef.current ?? pendingFeedbackAttemptIdRef.current;
        if (generation !== workflowGenerationRef.current || activeTarget !== item.clientAttemptId) {
          return null;
        }
        if (result.status === "retry") {
          await markFeedbackError(item.clientAttemptId, errorMessage(result.error)).catch(() => {
            // The ready queue row remains the recovery source if IDB is temporarily unavailable.
          });
          setRecoveryTarget(
            (current) =>
              current ?? {
                learnerId: item.learnerId,
                clientSessionId: item.clientSessionId,
                clientAttemptId: item.clientAttemptId,
                promptId: item.promptId,
                lang: item.lang,
                attemptIndex: item.attemptIndex,
                state: "awaiting-feedback",
                updatedAt: item.workflowUpdatedAt ?? item.createdAt,
                sessionId: item.sessionId,
                attemptId: item.attemptId!,
              },
          );
          setFeedbackRetryPending(true);
          setInterruptedDraftPending(false);
          setError(
            isOfflineFailure(result.error)
              ? "Recording uploaded. Feedback will load when your connection returns."
              : errorMessage(result.error),
          );
          dispatchPractice({
            type: "feedback-load-failed",
            message: errorMessage(result.error),
            attemptIndex: item.attemptIndex,
          });
          return null;
        }

        if (item.sessionId) setSessionId(item.sessionId);
        else if (result.attempt.sessionId) setSessionId(result.attempt.sessionId);
        if (item.attemptIndex === 1) {
          setFirst(result.attempt);
          dispatchPractice({ type: "ready", attemptIndex: 1 });
        } else {
          setSecond(result.attempt);
          dispatchPractice({ type: "ready", attemptIndex: 2 });
        }
        // Mark consumed in an effect after React commits feedback state. A
        // crash between fetch and commit leaves durable recovery available.
        setFeedbackPendingDelivery(item.clientAttemptId);
        setFeedbackRetryPending(false);
        setInterruptedDraftPending(false);
        setError(null);
        void refresh().catch((cause) => {
          if (generation !== workflowGenerationRef.current) return;
          setError(`Attempt saved, but progress could not refresh: ${errorMessage(cause)}`);
        });
        return result.attempt;
      })();
      readyAttemptResolutionRef.current.set(resolutionKey, resolution);
      void resolution.finally(() => {
        readyAttemptResolutionRef.current.delete(resolutionKey);
      });
      return resolution;
    },
    [refresh],
  );

  useEffect(() => {
    if (!feedbackPendingDelivery) return;
    const clientAttemptId = feedbackPendingDelivery;
    const generation = workflowGenerationRef.current;
    let cancelled = false;
    void markFeedbackDelivered(clientAttemptId)
      .then(() => {
        if (cancelled || generation !== workflowGenerationRef.current) return;
        if (interruptedAttemptIdRef.current === clientAttemptId) {
          interruptedAttemptIdRef.current = null;
        }
        if (pendingFeedbackAttemptIdRef.current === clientAttemptId) {
          pendingFeedbackAttemptIdRef.current = null;
        }
        setRecoveryTarget(null);
        setFeedbackPendingDelivery(null);
      })
      .catch((deliveryError) => {
        if (cancelled || generation !== workflowGenerationRef.current) return;
        const item = queuedItems.find((candidate) => candidate.clientAttemptId === clientAttemptId);
        if (item) {
          setRecoveryTarget(
            (current) =>
              current ?? {
                learnerId: item.learnerId,
                clientSessionId: item.clientSessionId,
                clientAttemptId: item.clientAttemptId,
                promptId: item.promptId,
                lang: item.lang,
                attemptIndex: item.attemptIndex,
                state: "awaiting-feedback",
                updatedAt: item.workflowUpdatedAt ?? item.createdAt,
                sessionId: item.sessionId,
                attemptId: item.attemptId!,
              },
          );
          setFeedbackRetryPending(true);
          dispatchPractice({
            type: "feedback-load-failed",
            message: errorMessage(deliveryError),
            attemptIndex: item.attemptIndex,
          });
        }
        setError(
          `Feedback loaded, but recovery state could not be saved: ${errorMessage(deliveryError)}`,
        );
        setFeedbackPendingDelivery(null);
      });
    return () => {
      cancelled = true;
    };
  }, [feedbackPendingDelivery, queuedItems]);

  const reconcileQueue = useCallback(async () => {
    const generation = ++queueReadGenerationRef.current;
    try {
      const items = await listRecordingQueue(getQueueLearnerIds());
      if (!queueMountedRef.current || generation !== queueReadGenerationRef.current) return;
      setQueuedItems(items);
      let clientAttemptId = interruptedAttemptIdRef.current ?? pendingFeedbackAttemptIdRef.current;
      if (!clientAttemptId && mode === "api") {
        const [workflow] = await listRecoveryWorkflows(getQueueLearnerIds());
        if (workflow) {
          clientAttemptId = workflow.clientAttemptId;
          interruptedAttemptIdRef.current = workflow.clientAttemptId;
          setRecoveryTarget(workflow);
          hydrateWorkflowContext(workflow);
          setFeedbackRetryPending(true);
          dispatchPractice({
            type: "feedback-load-failed",
            message: "Recording uploaded. Feedback is ready to load.",
            attemptIndex: workflow.attemptIndex,
          });
        }
      }
      const ready = findReadyRecording(items, clientAttemptId);
      if (ready) void resolveReadyAttempt(ready, workflowGenerationRef.current);
    } catch {
      // A later online/visibility/queue event retries the durable read.
    }
  }, [hydrateWorkflowContext, mode, resolveReadyAttempt]);

  useEffect(() => {
    queueMountedRef.current = true;
    void reconcileQueue();
    const unsubscribe = subscribeRecordingQueue(() => void reconcileQueue());
    const onLearnerReady = () => void reconcileQueue();
    // queue-ready is only a low-latency hint. Durable queue state below owns
    // correctness, including completion from another tab.
    const onQueueReady = () => void reconcileQueue();
    window.addEventListener("kotoba:learner-ready", onLearnerReady);
    window.addEventListener("kotoba:queue-ready", onQueueReady);
    return () => {
      queueMountedRef.current = false;
      queueReadGenerationRef.current += 1;
      unsubscribe();
      window.removeEventListener("kotoba:learner-ready", onLearnerReady);
      window.removeEventListener("kotoba:queue-ready", onQueueReady);
    };
  }, [reconcileQueue]);

  useEffect(() => {
    const clientAttemptId = interruptedAttemptIdRef.current ?? pendingFeedbackAttemptIdRef.current;
    const ready = findReadyRecording(queuedItems, clientAttemptId);
    if (ready) void resolveReadyAttempt(ready, workflowGenerationRef.current);
  }, [queuedItems, resolveReadyAttempt]);

  const retryReadyFeedback = useCallback(() => {
    dispatchPractice({ type: "feedback-retry-requested" });
    void reconcileQueue();
  }, [reconcileQueue]);

  useEffect(() => {
    const retry = () => retryReadyFeedback();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [retryReadyFeedback]);

  const startOver = useCallback(async () => {
    const target = recoveryTarget;
    workflowGenerationRef.current += 1;
    if (target) {
      await abandonWorkflow(target.clientAttemptId);
    }
    const nextClientSessionId = crypto.randomUUID();
    clientSessionIdRef.current = nextClientSessionId;
    interruptedAttemptIdRef.current = null;
    pendingFeedbackAttemptIdRef.current = null;
    readyAttemptResolutionRef.current.clear();
    setRecoveryTarget(null);
    setFeedbackPendingDelivery(null);
    setFeedbackRetryPending(false);
    setInterruptedDraftPending(false);
    setFirst(null);
    setSecond(null);
    setFrozenContext(null);
    setSessionId(null);
    setError(null);
    recorder.reset();
    dispatchPractice({ type: "next-prompt" });
  }, [recoveryTarget, recorder]);
  useEffect(() => {
    setBusy(
      recorder.status === "recording" || step === "processing" || step === "processing2",
      "practice",
    );
    return () => setBusy(false, "practice");
  }, [recorder.status, setBusy, step]);

  if (!ready) {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <div className="mx-auto max-w-3xl px-4 py-12">
          <div className="h-56 animate-pulse rounded-3xl bg-secondary" />
        </div>
      </div>
    );
  }

  if (mode === "api" && recoveryTarget && step === "feedback-recovery") {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
          <FeedbackRecovery
            workflow={recoveryTarget}
            error={error}
            onRetry={retryReadyFeedback}
            onStartOver={() => void startOver()}
          />
        </main>
      </div>
    );
  }

  if (!state.onboarded || !state.lang || !prompt) {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <main className="mx-auto max-w-3xl px-4 py-12 text-center">
          <h1 className="font-display text-2xl">Choose a practice language first</h1>
          <p className="mt-2 text-sm text-muted-foreground">Head home to finish onboarding.</p>
          <Button asChild className="mt-5 rounded-full">
            <Link to="/">Go home</Link>
          </Button>
        </main>
      </div>
    );
  }

  const beginSession = async () => {
    setError(null);
    if (!prompt) {
      setError("No prompts are available for this language yet.");
      return;
    }
    if (mode === "api") {
      setStarting(true);
      const generation = workflowGenerationRef.current;
      const clientSessionId = clientSessionIdRef.current ?? crypto.randomUUID();
      clientSessionIdRef.current = clientSessionId;
      setFrozenContext({ clientSessionId, sessionId: null, promptId: prompt.id, lang });
      try {
        const session = await createSession(prompt.id, clientSessionId);
        if (
          generation !== workflowGenerationRef.current ||
          clientSessionIdRef.current !== clientSessionId
        ) {
          setStarting(false);
          return;
        }
        setSessionId(session.id);
      } catch (cause) {
        // Offline is not a blocker: the session is created from the same
        // idempotency key when the queued recording uploads.
        if (isOfflineFailure(cause)) {
          setSessionId(null);
          setError("You are offline. Record now — this session uploads when you reconnect.");
        } else {
          setError(errorMessage(cause));
          setStarting(false);
          return;
        }
      }
      setStarting(false);
    }
    dispatchPractice({ type: "begin" });
  };

  const submit = async (index: 1 | 2) => {
    setError(null);
    workflowGenerationRef.current += 1;
    const generation = workflowGenerationRef.current;
    dispatchPractice({ type: "submit", attemptIndex: index });
    dispatchPractice({ type: "processing", attemptIndex: index });
    const clientAttemptId = interruptedAttemptIdRef.current ?? crypto.randomUUID();
    const identity = frozenContext
      ? queueIdentityForAttempt(frozenContext, index)
      : {
          clientSessionId: clientSessionIdRef.current!,
          promptId: prompt?.id ?? "",
          lang,
          attemptIndex: index,
        };
    try {
      if (!prompt) throw new Error("No prompt is selected.");
      if (mode === "api" && frozenContext) {
        clientSessionIdRef.current = frozenContext.clientSessionId;
      }
      let attempt: Attempt;
      if (mode === "api") {
        if (!sessionId && !clientSessionIdRef.current) {
          throw new Error("The practice session is missing. Start again.");
        }
        if (!recorder.audioBlob) {
          throw new Error("A real microphone recording is required in API mode.");
        }
        const queueLearnerIds = getQueueLearnerIds();
        interruptedAttemptIdRef.current = clientAttemptId;
        pendingFeedbackAttemptIdRef.current = null;
        setFeedbackRetryPending(false);
        // Persist before any network mutation. A page kill after this point
        // leaves an idempotent durable record instead of an in-memory Blob only.
        try {
          const canonicalClientAttemptId = await enqueueRecording(
            {
              learnerId: getQueueLearnerId(),
              clientAttemptId,
              sessionId,
              clientSessionId: identity.clientSessionId,
              promptId: identity.promptId,
              lang: identity.lang,
              attemptIndex: identity.attemptIndex,
              duration: recorder.seconds || 1,
              mimeType: recorder.audioBlob.type || "audio/webm",
              blob: recorder.audioBlob,
              createdAt: Date.now(),
            },
            queueLearnerIds,
          );
          interruptedAttemptIdRef.current = canonicalClientAttemptId;
        } catch {
          // No durable row exists when enqueue fails, so do not reuse this
          // client id for a later recording.
          interruptedAttemptIdRef.current = null;
          throw new Error(
            "This browser cannot safely save recordings for upload. Enable site storage and try again.",
          );
        }
        const syncResult = await syncRecordingQueue(async (item) => {
          const { attempt: queuedAttempt, sessionId: queuedSessionId } =
            await uploadQueuedAttempt(item);
          return {
            id: queuedAttempt.id,
            status: queuedAttempt.status,
            sessionId: queuedSessionId,
          };
        }, queueLearnerIds);
        if (!syncResult.acquired) {
          throw new ApiClientError(
            "Another tab is uploading this recording. It will continue automatically.",
            503,
            "queue_busy",
          );
        }
        const queued = (await listRecordingQueue(queueLearnerIds)).find(
          (item) => item.clientAttemptId === interruptedAttemptIdRef.current,
        );
        if (!queued || queued.syncStatus === "queued" || queued.syncStatus === "uploading") {
          throw new ApiClientError(
            queued?.lastError ?? "The recording is waiting for a retry.",
            0,
            "offline_queue_pending",
          );
        }
        if (queued.syncStatus === "processing") {
          throw new ApiClientError(
            "The recording is still being processed.",
            503,
            "processing_unavailable",
          );
        }
        if (queued.syncStatus === "failed" || !queued.attemptId) {
          throw new ApiClientError(
            queued.lastError ?? "The recording could not be uploaded.",
            400,
            "attempt_failed",
          );
        }
        const resolved = await resolveReadyAttempt(queued);
        if (!resolved) recorder.reset();
        return;
      } else {
        // Demo feedback is deterministic sample data even if the browser captured a local blob.
        attempt = await analyzeAttempt(prompt, index, recorder.seconds || 32, true);
        if (generation !== workflowGenerationRef.current) return;
      }
      if (index === 1) {
        setFirst(attempt);
        dispatchPractice({ type: "ready", attemptIndex: 1 });
        recordSession({
          id: sessionId ?? `s-${Date.now()}`,
          lang,
          promptId: prompt.id,
          date: todayIso(),
          first: attempt.feedback.overall,
          second: null,
        });
      } else {
        setSecond(attempt);
        dispatchPractice({ type: "ready", attemptIndex: 2 });
        recordSession({
          id: sessionId ?? `s-${Date.now()}`,
          lang,
          promptId: prompt.id,
          date: todayIso(),
          first: first?.feedback.overall ?? attempt.feedback.overall,
          second: attempt.feedback.overall,
        });
      }
    } catch (cause) {
      const queueWaiting =
        cause instanceof ApiClientError &&
        (cause.code === "queue_busy" || cause.code === "processing_unavailable");
      if (queueWaiting) {
        setInterruptedDraftPending(true);
        setError(errorMessage(cause));
        dispatchPractice({ type: "failed", message: errorMessage(cause), attemptIndex: index });
        recorder.reset();
        return;
      }
      if (
        mode === "api" &&
        isOfflineFailure(cause) &&
        clientSessionIdRef.current &&
        prompt &&
        recorder.audioBlob
      ) {
        try {
          const learnerId = getQueueLearnerId();
          await enqueueRecording(
            {
              learnerId,
              clientAttemptId,
              sessionId,
              clientSessionId: identity.clientSessionId,
              promptId: identity.promptId,
              lang: identity.lang,
              attemptIndex: identity.attemptIndex,
              duration: recorder.seconds || 1,
              mimeType: recorder.audioBlob.type || "audio/webm",
              blob: recorder.audioBlob,
              createdAt: Date.now(),
            },
            getQueueLearnerIds(),
          );
          setError(
            "Offline: recording saved on this device. It will upload automatically when online.",
          );
          interruptedAttemptIdRef.current = clientAttemptId;
          setInterruptedDraftPending(true);
          dispatchPractice({ type: "offline", attemptIndex: index });
          recorder.reset();
          return;
        } catch {
          /* surface the original error below */
        }
      }
      setError(errorMessage(cause));
      dispatchPractice({ type: "failed", message: errorMessage(cause), attemptIndex: index });
      return;
    }
    interruptedAttemptIdRef.current = null;
    pendingFeedbackAttemptIdRef.current = null;
    setFeedbackRetryPending(false);
    setInterruptedDraftPending(false);
    recorder.reset();
  };

  const retryOffline = async () => {
    const learnerIds = getQueueLearnerIds();
    dispatchPractice({ type: "retry", attemptIndex: practiceState.attemptIndex });
    await retryQueuedRecordings(learnerIds);
    setBusy(true, "queue");
    try {
      await syncRecordingQueue(async (item) => {
        const { attempt, sessionId } = await uploadQueuedAttempt(item);
        return { id: attempt.id, status: attempt.status, sessionId };
      }, learnerIds);
    } finally {
      setBusy(false, "queue");
    }
  };

  const current = second ?? first;
  const pendingQueueItems = queuedItems.filter((item) => item.syncStatus !== "ready");
  const failedQueueItems = queuedItems.filter((item) => item.syncStatus === "failed");
  const readyQueueItems = queuedItems.filter((item) => item.syncStatus === "ready");

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
        <Stepper step={step} />

        {storeError || error ? (
          <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? storeError}
          </p>
        ) : null}
        {queuedItems.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
            <span className="flex-1">
              {feedbackRetryPending
                ? "Recording uploaded. Feedback is ready to load."
                : pendingQueueItems.length > 0
                  ? `${pendingQueueItems.length} recording(s) ${
                      pendingQueueItems.some((item) => item.syncStatus === "uploading")
                        ? "uploading"
                        : pendingQueueItems.some((item) => item.syncStatus === "processing")
                          ? "processing"
                          : pendingQueueItems.some((item) => item.syncStatus === "queued")
                            ? "waiting to upload"
                            : "failed and ready to retry"
                    }.`
                  : `${readyQueueItems.length} recording(s) uploaded successfully.`}
            </span>
            {feedbackRetryPending ? (
              <Button size="sm" variant="outline" onClick={retryReadyFeedback}>
                Retry feedback
              </Button>
            ) : failedQueueItems.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void retryOffline()}>
                Retry upload
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 space-y-6">
          {step === "prompt" ? (
            <>
              <PromptCard prompt={prompt} mode={mode} />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="lg"
                  className="h-14 rounded-full px-7 text-base shadow-tactile"
                  onClick={() => void beginSession()}
                  disabled={starting}
                >
                  {starting ? "Setting up your session…" : "I'm ready — record my answer"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    workflowGenerationRef.current += 1;
                    clientSessionIdRef.current = crypto.randomUUID();
                    setFeedbackPendingDelivery(null);
                    setSessionId(null);
                    setFirst(null);
                    setSecond(null);
                    setFrozenContext(null);
                    setPromptOffset((o) => o + 1);
                    dispatchPractice({ type: "next-prompt" });
                  }}
                  className="text-muted-foreground"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Different prompt
                </Button>
              </div>
            </>
          ) : null}

          {step === "record" ||
          step === "record2" ||
          step === "recording" ||
          step === "recorded" ? (
            <>
              <PromptCard prompt={prompt} compact mode={mode} />
              {step === "record2" && first ? (
                <div className="rounded-2xl border border-primary/40 bg-primary/8 px-4 py-3">
                  <p className="text-sm font-semibold">Second take — focus on this:</p>
                  <ul className={cn("mt-1 list-disc space-y-0.5 pl-5 text-sm", jp && "font-jp")}>
                    {first.feedback.improvements.map((i) => (
                      <li key={i.title}>{i.title}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <RecordControls
                recorder={recorder}
                targetSeconds={prompt.seconds}
                submitLabel={
                  practiceState.attemptIndex === 1 ? "Get feedback" : "See my improvement"
                }
                onSubmit={() => void submit(practiceState.attemptIndex)}
                mode={mode}
                onUseDemo={switchToDemo}
                onStartRecording={() => {
                  workflowGenerationRef.current += 1;
                  pendingFeedbackAttemptIdRef.current = null;
                  setFeedbackRetryPending(false);
                }}
                savedDraft={interruptedDraftPending}
              />
            </>
          ) : null}

          {step === "offline-recovery" || step === "retry" ? (
            <section className="rounded-3xl border border-warn/40 bg-warn/10 p-6 shadow-lift">
              <h1 className="font-display text-xl">Recording saved for upload</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Your answer stays on this device. Retry upload when connection returns; it will not
                be recorded again.
              </p>
              <Button className="mt-5" onClick={() => void retryOffline()}>
                Retry upload
              </Button>
            </section>
          ) : null}

          {step === "processing" ? <Processing label="Listening to your answer…" /> : null}
          {step === "processing2" ? <Processing label="Comparing with your first take…" /> : null}

          {(step === "feedback" || step === "result") && current ? (
            <FeedbackView
              attempt={current}
              previous={step === "result" ? first : null}
              jp={jp}
              mode={mode}
              isSaved={isSaved}
              onToggleSave={(e) => {
                const wasSaved = isSaved(e.id);
                void toggleSaved(e)
                  .then(() => toast.success(wasSaved ? "Removed from saved" : "Saved for review"))
                  .catch((cause) => toast.error(errorMessage(cause)));
              }}
            />
          ) : null}

          {step === "feedback" ? (
            <div className="flex flex-wrap gap-3">
              <Button
                size="lg"
                className="h-14 rounded-full px-7 text-base shadow-tactile"
                onClick={() => {
                  workflowGenerationRef.current += 1;
                  interruptedAttemptIdRef.current = null;
                  pendingFeedbackAttemptIdRef.current = null;
                  setFeedbackPendingDelivery(null);
                  setFeedbackRetryPending(false);
                  recorder.reset();
                  dispatchPractice({ type: "second-attempt-started" });
                }}
              >
                Try again with these fixes
                <ArrowRight className="size-5" aria-hidden />
              </Button>
              <Button variant="outline" size="lg" className="h-14 rounded-full px-6" asChild>
                <Link to="/">Finish for now</Link>
              </Button>
            </div>
          ) : null}

          {step === "result" ? (
            <div className="flex flex-wrap gap-3">
              <Button
                size="lg"
                className="h-14 rounded-full px-7 text-base shadow-tactile"
                onClick={() => {
                  workflowGenerationRef.current += 1;
                  setFirst(null);
                  setSecond(null);
                  setFrozenContext(null);
                  setPromptOffset((o) => o + 1);
                  setSessionId(mode === "demo" ? `s-${Date.now()}` : null);
                  clientSessionIdRef.current = crypto.randomUUID();
                  interruptedAttemptIdRef.current = null;
                  pendingFeedbackAttemptIdRef.current = null;
                  setFeedbackPendingDelivery(null);
                  setFeedbackRetryPending(false);
                  recorder.reset();
                  dispatchPractice({ type: "next-prompt" });
                }}
              >
                Next prompt
              </Button>
              <Button variant="outline" size="lg" className="h-14 rounded-full px-6" asChild>
                <Link to="/progress">See progress</Link>
              </Button>
              <Button variant="ghost" size="lg" className="h-14 rounded-full px-6" asChild>
                <Link to="/saved">Saved expressions</Link>
              </Button>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const SCORE_KEYS: ScoreKey[] = [
  "fluency",
  "pauses",
  "grammar",
  "vocabulary",
  "naturalness",
  "pronunciation",
];

function FeedbackView({
  attempt,
  previous,
  jp,
  mode,
  isSaved,
  onToggleSave,
}: {
  attempt: Attempt;
  previous: Attempt | null;
  jp: boolean;
  mode: import("@/lib/practice/mode").AppMode;
  isSaved: (id: string) => boolean;
  onToggleSave: (e: import("@/lib/practice/types").Expression) => void;
}) {
  const fb = attempt.feedback;
  const delta = previous ? fb.overall - previous.feedback.overall : null;
  const metricsUnavailable = fb.speechMetricsStatus === "unavailable" && !attempt.mocked;
  const metricsNotice = attempt.mocked
    ? "Demo stats are illustrative. Your audio is not analyzed."
    : fb.speechMetricsStatus === "degraded"
      ? "Some speech stats come from transcript or client timing, not acoustic measurement."
      : metricsUnavailable
        ? "Audio timing was unavailable for this attempt."
        : null;

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-card p-5 shadow-lift sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {attempt.index === 1 ? "First attempt" : "Second attempt"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <ScoreDial value={fb.overall} delta={delta} label={fb.headline} />
        </div>
        {delta !== null && delta > 0 ? (
          <p className="mt-3 rounded-2xl bg-success/12 px-4 py-3 text-sm font-medium">
            Fewer fillers ({previous?.feedback.stats.fillers} → {fb.stats.fillers}), faster pace (
            {previous?.feedback.stats.wpm} → {fb.stats.wpm} wpm) and your longest pause dropped to{" "}
            {fb.stats.longestPause}.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="fixes">
        <h2 id="fixes" className="font-display text-xl">
          {attempt.index === 1 ? "Fix these first" : "Keep working on"}
        </h2>
        <ul className="mt-3 space-y-3">
          {fb.improvements.map((item, i) => (
            <ImprovementCard
              key={item.title}
              item={item}
              index={i + 1}
              jp={jp}
              lang={jp ? "ja" : "en"}
              mode={mode}
            />
          ))}
        </ul>
      </section>

      <section
        className="rounded-3xl border border-border bg-card p-5 shadow-lift sm:p-6"
        aria-labelledby="transcript"
      >
        <h2 id="transcript" className="font-display text-xl">
          What we heard
        </h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          {attempt.mocked
            ? "Sample transcript — demo feedback uses a deterministic answer; your audio is not analyzed."
            : "Auto-transcribed from your recording."}
        </p>
        <TranscriptView annotations={fb.annotations} jp={jp} />
      </section>

      <section aria-labelledby="expressions">
        <h2 id="expressions" className="font-display text-xl">
          Expressions worth keeping
        </h2>
        <ul className="mt-3 space-y-2">
          {fb.expressions.map((e) => (
            <ExpressionRow
              key={e.id}
              expression={e}
              saved={isSaved(e.id)}
              mode={mode}
              onToggle={() => onToggleSave(e)}
            />
          ))}
        </ul>
      </section>

      <Accordion
        type="single"
        collapsible
        className="rounded-3xl border border-border bg-card px-5"
      >
        <AccordionItem value="detail" className="border-none">
          <AccordionTrigger className="font-display text-lg">Detailed breakdown</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-6">
            <div className="grid gap-3 sm:grid-cols-2">
              {SCORE_KEYS.map((k) => {
                const value = fb.scores[k];
                if (
                  typeof value !== "number" ||
                  (k === "pronunciation" && fb.pronunciationStatus === "unavailable")
                )
                  return null;
                const previousValue = previous?.feedback.scores[k];
                return (
                  <ScoreBar
                    key={k}
                    label={k}
                    value={value}
                    previous={typeof previousValue === "number" ? previousValue : undefined}
                  />
                );
              })}
            </div>
            {metricsNotice ? (
              <p className="mb-3 text-xs text-muted-foreground">{metricsNotice}</p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["Words", metricsUnavailable ? "Unavailable" : String(fb.stats.words)],
                ["Speed", metricsUnavailable ? "Unavailable" : `${fb.stats.wpm} wpm`],
                ["Fillers", metricsUnavailable ? "Unavailable" : String(fb.stats.fillers)],
                ["Longest pause", metricsUnavailable ? "Unavailable" : fb.stats.longestPause],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-secondary/60 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
