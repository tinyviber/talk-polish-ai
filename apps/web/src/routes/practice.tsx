import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
import { useRecorder } from "@/lib/practice/useRecorder";
import { analyzeAttempt } from "@/lib/practice/mockServices";
import { createAttempt, createSession, toReadyAttempt } from "@/lib/practice/api";
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
  const recorder = useRecorder({ mode });
  const [step, setStep] = useState<Step>("prompt");
  const [first, setFirst] = useState<Attempt | null>(null);
  const [second, setSecond] = useState<Attempt | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    mode === "demo" ? `s-${Date.now()}` : null,
  );
  const [promptOffset, setPromptOffset] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lang = state.lang ?? "en";
  const languagePrompts = useMemo(
    () => prompts.filter((prompt) => prompt.lang === lang),
    [lang, prompts],
  );
  // Frozen at mount so the prompt never changes mid-session when a session is recorded.
  const [baseIndex] = useState(() => state.sessions.filter((s) => s.lang === lang).length);
  const prompt = languagePrompts[(baseIndex + promptOffset) % Math.max(1, languagePrompts.length)];
  const jp = lang === "ja";

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
      try {
        const session = await createSession(prompt.id);
        setSessionId(session.id);
      } catch (cause) {
        setError(errorMessage(cause));
        setStarting(false);
        return;
      }
      setStarting(false);
    }
    setStep("record");
  };

  const submit = async (index: 1 | 2) => {
    setError(null);
    setStep(index === 1 ? "processing" : "processing2");
    try {
      if (!prompt) throw new Error("No prompt is selected.");
      let attempt: Attempt;
      if (mode === "api") {
        if (!sessionId) throw new Error("The practice session is missing. Start again.");
        if (!recorder.audioBlob) {
          throw new Error("A real microphone recording is required in API mode.");
        }
        attempt = toReadyAttempt(
          await createAttempt(sessionId, {
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
      setError(errorMessage(cause));
      setStep(index === 1 ? "record" : "record2");
      return;
    }
    recorder.reset();
  };

  const current = second ?? first;

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
