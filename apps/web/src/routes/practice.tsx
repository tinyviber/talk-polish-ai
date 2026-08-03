import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  createAttempt,
  createSession,
  getAttempt,
  getLearnerId,
  toReadyAttempt,
  uploadQueuedAttempt,
} from "@/lib/practice/api";
import {
  enqueueRecording,
  listRecordingQueue,
  retryQueuedRecordings,
  subscribeRecordingQueue,
  syncRecordingQueue,
  type RecordingQueueItem,
} from "@/lib/practice/offlineQueue";
import { usePwa } from "@/lib/pwa";
import type { Attempt, ScoreKey } from "@/lib/practice/types";
import { cn } from "@/lib/utils";

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

type Step = "prompt" | "record" | "processing" | "feedback" | "record2" | "processing2" | "result";

const STEP_INDEX: Record<Step, number> = {
  prompt: 1,
  record: 1,
  processing: 2,
  feedback: 2,
  record2: 3,
  processing2: 3,
  result: 4,
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
  const [step, setStep] = useState<Step>("prompt");
  const [first, setFirst] = useState<Attempt | null>(null);
  const [second, setSecond] = useState<Attempt | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    mode === "demo" ? `s-${Date.now()}` : null,
  );
  const [promptOffset, setPromptOffset] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interruptedDraftPending, setInterruptedDraftPending] = useState(false);
  const { setBusy } = usePwa();
  const interruptedAttemptIdRef = useRef<string | null>(null);
  // Generated when a session starts so recordings captured with no network can
  // still be attached to one practice session once the device reconnects.
  const clientSessionIdRef = useRef<string | null>(null);

  const lang = state.lang ?? "en";
  const languagePrompts = useMemo(
    () => prompts.filter((prompt) => prompt.lang === lang),
    [lang, prompts],
  );
  // Frozen at mount so the prompt never changes mid-session when a session is recorded.
  const [baseIndex] = useState(() => state.sessions.filter((s) => s.lang === lang).length);
  const prompt = languagePrompts[(baseIndex + promptOffset) % Math.max(1, languagePrompts.length)];
  const jp = lang === "ja";
  const saveInterruptedDraft = useCallback(
    async (draft: RecorderDraft) => {
      if (mode !== "api" || !prompt) return;
      const clientSessionId = clientSessionIdRef.current;
      if (!clientSessionId) return;
      const learnerId = getLearnerId();
      if (!learnerId) {
        setError("Your learner session is not ready; the interrupted take was not queued.");
        return;
      }
      const clientAttemptId = interruptedAttemptIdRef.current ?? crypto.randomUUID();
      interruptedAttemptIdRef.current = clientAttemptId;
      // Keep this separate from recorder.status: the latter becomes recorded
      // before the asynchronous IndexedDB write finishes.
      setBusy(true, "draft-save");
      try {
        await enqueueRecording({
          learnerId,
          clientAttemptId,
          sessionId,
          clientSessionId,
          promptId: prompt.id,
          lang,
          attemptIndex: step === "record2" ? 2 : 1,
          duration: draft.durationSec,
          mimeType: draft.mimeType,
          blob: draft.blob,
          createdAt: Date.now(),
        });
        setInterruptedDraftPending(true);
        setError(
          "Your interrupted recording was saved on this device and will upload when you reconnect.",
        );
      } finally {
        setBusy(false, "draft-save");
      }
    },
    [lang, mode, prompt, sessionId, setBusy, step],
  );
  const recorder = useRecorder({ mode, onInterruptedRecording: saveInterruptedDraft });
  const [queuedItems, setQueuedItems] = useState<RecordingQueueItem[]>([]);
  useEffect(() => {
    const refreshQueue = () =>
      void listRecordingQueue(getLearnerId() ?? undefined)
        .then(setQueuedItems)
        .catch(() => {});
    refreshQueue();
    const unsubscribe = subscribeRecordingQueue(refreshQueue);
    const onLearnerReady = () => refreshQueue();
    const onQueueReady = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          learnerId: string;
          sessionId: string | null;
          clientSessionId?: string;
          attemptIndex: 1 | 2;
          attemptId: string;
        }>
      ).detail;
      const belongsToThisSession =
        detail &&
        detail.learnerId === getLearnerId() &&
        (detail.sessionId === sessionId ||
          (clientSessionIdRef.current !== null &&
            detail.clientSessionId === clientSessionIdRef.current));
      if (!belongsToThisSession) return;
      if (detail.sessionId) setSessionId(detail.sessionId);
      void getAttempt(detail.attemptId)
        .then((value) => {
          const attempt = toReadyAttempt(value);
          if (detail.attemptIndex === 1) {
            setFirst(attempt);
            setStep("feedback");
          } else {
            setSecond(attempt);
            setStep("result");
          }
          interruptedAttemptIdRef.current = null;
          setInterruptedDraftPending(false);
          setError(null);
        })
        .catch((cause) => setError(errorMessage(cause)));
    };
    window.addEventListener("kotoba:learner-ready", onLearnerReady);
    window.addEventListener("kotoba:queue-ready", onQueueReady);
    return () => {
      unsubscribe();
      window.removeEventListener("kotoba:learner-ready", onLearnerReady);
      window.removeEventListener("kotoba:queue-ready", onQueueReady);
    };
  }, [sessionId]);
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
      const clientSessionId = clientSessionIdRef.current ?? crypto.randomUUID();
      clientSessionIdRef.current = clientSessionId;
      try {
        const session = await createSession(prompt.id, clientSessionId);
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
    setStep("record");
  };

  const submit = async (index: 1 | 2) => {
    setError(null);
    setStep(index === 1 ? "processing" : "processing2");
    const clientAttemptId = interruptedAttemptIdRef.current ?? crypto.randomUUID();
    try {
      if (!prompt) throw new Error("No prompt is selected.");
      let attempt: Attempt;
      if (mode === "api") {
        if (!sessionId && !clientSessionIdRef.current) {
          throw new Error("The practice session is missing. Start again.");
        }
        if (!recorder.audioBlob) {
          throw new Error("A real microphone recording is required in API mode.");
        }
        const resolvedSessionId =
          sessionId ?? (await createSession(prompt.id, clientSessionIdRef.current!)).id;
        if (resolvedSessionId !== sessionId) setSessionId(resolvedSessionId);
        attempt = toReadyAttempt(
          await createAttempt(resolvedSessionId, {
            clientAttemptId,
            index,
            durationSec: recorder.seconds || 1,
            audio: recorder.audioBlob,
          }),
        );
      } else {
        // Demo feedback is deterministic sample data even if the browser captured a local blob.
        attempt = await analyzeAttempt(prompt, index, recorder.seconds || 32, true);
      }
      const refreshAfterSuccess = () => {
        if (mode !== "api") return;
        void refresh().catch((cause) => {
          setError(`Attempt saved, but progress could not refresh: ${errorMessage(cause)}`);
        });
      };
      if (index === 1) {
        setFirst(attempt);
        setStep("feedback");
        if (mode === "demo") {
          recordSession({
            id: sessionId ?? `s-${Date.now()}`,
            lang,
            promptId: prompt.id,
            date: todayIso(),
            first: attempt.feedback.overall,
            second: null,
          });
        } else {
          refreshAfterSuccess();
        }
      } else {
        setSecond(attempt);
        setStep("result");
        if (mode === "demo") {
          recordSession({
            id: sessionId ?? `s-${Date.now()}`,
            lang,
            promptId: prompt.id,
            date: todayIso(),
            first: first?.feedback.overall ?? attempt.feedback.overall,
            second: attempt.feedback.overall,
          });
        } else {
          refreshAfterSuccess();
        }
      }
    } catch (cause) {
      if (
        mode === "api" &&
        isOfflineFailure(cause) &&
        clientSessionIdRef.current &&
        prompt &&
        recorder.audioBlob
      ) {
        try {
          const learnerId = getLearnerId();
          if (!learnerId) throw new Error("Learner session is unavailable.");
          await enqueueRecording({
            learnerId,
            clientAttemptId,
            sessionId,
            clientSessionId: clientSessionIdRef.current,
            promptId: prompt.id,
            lang,
            attemptIndex: index,
            duration: recorder.seconds || 1,
            mimeType: recorder.audioBlob.type || "audio/webm",
            blob: recorder.audioBlob,
            createdAt: Date.now(),
          });
          setError(
            "Offline: recording saved on this device. It will upload automatically when online.",
          );
          interruptedAttemptIdRef.current = clientAttemptId;
          setInterruptedDraftPending(true);
          setStep(index === 1 ? "record" : "record2");
          recorder.reset();
          return;
        } catch {
          /* surface the original error below */
        }
      }
      setError(errorMessage(cause));
      setStep(index === 1 ? "record" : "record2");
      return;
    }
    interruptedAttemptIdRef.current = null;
    setInterruptedDraftPending(false);
    recorder.reset();
  };

  const retryOffline = async () => {
    const learnerId = getLearnerId();
    if (!learnerId) return;
    await retryQueuedRecordings(learnerId);
    setBusy(true, "queue");
    try {
      await syncRecordingQueue(async (item) => {
        const { attempt, sessionId } = await uploadQueuedAttempt(item);
        return { id: attempt.id, status: attempt.status, sessionId };
      }, learnerId);
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
              {pendingQueueItems.length > 0
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
            {failedQueueItems.length > 0 ? (
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
                  onClick={() => setPromptOffset((o) => o + 1)}
                  className="text-muted-foreground"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Different prompt
                </Button>
              </div>
            </>
          ) : null}

          {step === "record" || step === "record2" ? (
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
                submitLabel={step === "record" ? "Get feedback" : "See my improvement"}
                onSubmit={() => void submit(step === "record" ? 1 : 2)}
                mode={mode}
                onUseDemo={switchToDemo}
                savedDraft={interruptedDraftPending}
              />
            </>
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
                  interruptedAttemptIdRef.current = null;
                  recorder.reset();
                  setStep("record2");
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
                  setFirst(null);
                  setSecond(null);
                  setPromptOffset((o) => o + 1);
                  setSessionId(mode === "demo" ? `s-${Date.now()}` : null);
                  interruptedAttemptIdRef.current = null;
                  recorder.reset();
                  setStep("prompt");
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
              {SCORE_KEYS.map((k) => (
                <ScoreBar
                  key={k}
                  label={k}
                  value={fb.scores[k]}
                  previous={previous?.feedback.scores[k]}
                />
              ))}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["Words", String(fb.stats.words)],
                ["Speed", `${fb.stats.wpm} wpm`],
                ["Fillers", String(fb.stats.fillers)],
                ["Longest pause", fb.stats.longestPause],
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
