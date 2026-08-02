import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Bookmark, Flame, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/practice/AppHeader";
import { PromptCard } from "@/components/practice/PromptCard";
import { computeStreak, usePracticeStore } from "@/lib/practice/store";
import type { Lang } from "@/lib/practice/types";
import { cn } from "@/lib/utils";

const LANG_LABEL: Record<Lang, string> = { en: "English", ja: "日本語 Japanese" };

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Kotoba Loop — speak English & Japanese with confidence" },
      {
        name: "description",
        content:
          "Short guided speaking sessions with instant coaching on fluency, grammar and naturalness in English and Japanese.",
      },
      { property: "og:title", content: "Kotoba Loop — speak English & Japanese with confidence" },
      {
        property: "og:description",
        content:
          "Record an answer, get 2–3 focused fixes, then say it again better. English and Japanese.",
      },
    ],
  }),
  component: Home,
});

function Onboarding() {
  const { completeOnboarding, mode, error } = usePracticeStore();
  const navigate = useNavigate();

  const choose = async (lang: Lang) => {
    try {
      await completeOnboarding(lang);
      await navigate({ to: "/practice" });
    } catch {
      // The provider exposes a user-facing error below.
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4 py-12">
      <span className="w-fit rounded-full bg-primary px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary-foreground">
        Kotoba Loop
      </span>
      <h1 className="mt-5 font-display text-4xl leading-tight sm:text-5xl">
        You understand plenty.
        <br />
        Now let's get it out of your mouth.
      </h1>
      <p className="mt-4 max-w-lg text-muted-foreground">
        Two-minute sessions: answer a real situation out loud, get two or three fixes that actually
        matter, then say it again — better.
      </p>

      <h2 className="mt-10 font-display text-xl">Which language are you practising?</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(["en", "ja"] as Lang[]).map((lang) => (
          <button
            key={lang}
            onClick={() => choose(lang)}
            className="group rounded-3xl border border-border bg-card p-5 text-left shadow-tactile transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5"
          >
            <span className="font-display text-2xl">{lang === "en" ? "English" : "日本語"}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {lang === "en" ? "Work, travel & everyday conversation" : "仕事・旅行・日常会話"}
            </span>
            <span className="mt-4 flex items-center gap-1 text-sm font-semibold text-primary">
              Start{" "}
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
          </button>
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        You can switch languages any time.{" "}
        {mode === "demo"
          ? "Nothing leaves your browser."
          : "Your recording is sent to the configured API for processing."}
      </p>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </main>
  );
}

function Home() {
  const { ready, state, setLang, prompts, mode, error } = usePracticeStore();

  if (!ready) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-16">
          <div className="h-8 w-48 animate-pulse rounded-full bg-secondary" />
          <div className="h-48 animate-pulse rounded-3xl bg-secondary" />
        </div>
      </div>
    );
  }

  if (!state.onboarded || !state.lang) return <Onboarding />;

  const lang = state.lang;
  const languagePrompts = prompts.filter((prompt) => prompt.lang === lang);
  if (languagePrompts.length === 0) {
    return <div className="min-h-screen" />;
  }
  const done = state.sessions.filter((s) => s.lang === lang).length;
  const next = languagePrompts[done % languagePrompts.length]!;
  const streak = computeStreak(state.sessions);
  const recent = state.saved.slice(0, 3);
  const improved = state.sessions.filter((s) => s.second !== null);
  const avgGain =
    improved.length > 0
      ? Math.round(improved.reduce((a, s) => a + ((s.second ?? 0) - s.first), 0) / improved.length)
      : null;

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
        {error ? (
          <p className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {mode} mode
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              {streak > 0 ? `Day ${streak} of your streak` : "Let's start a streak"}
            </p>
            <h1 className="mt-1 font-display text-3xl sm:text-4xl">Ready for a round?</h1>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
            {(["en", "ja"] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  lang === l
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {LANG_LABEL[l]}
              </button>
            ))}
          </div>
        </div>

        <section className="mt-6" aria-labelledby="next-up">
          <h2 id="next-up" className="sr-only">
            Next recommended practice
          </h2>
          <PromptCard prompt={next} />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="h-14 rounded-full px-7 text-base shadow-tactile">
              <Link to="/practice">
                <Sparkles className="size-5" aria-hidden />
                Start this session
              </Link>
            </Button>
            <p className="text-sm text-muted-foreground">Two attempts · about 3 minutes</p>
          </div>
        </section>

        <section className="mt-10 grid gap-4 sm:grid-cols-3" aria-label="Your progress at a glance">
          <Stat
            icon={<Flame className="size-4" aria-hidden />}
            label="Day streak"
            value={String(streak)}
          />
          <Stat label="Sessions" value={String(state.sessions.length)} />
          <Stat
            label="Avg. gain on 2nd try"
            value={avgGain === null ? "—" : `+${avgGain}`}
            hint={avgGain === null ? "Finish a session to see it" : "points"}
          />
        </section>

        <section className="mt-10" aria-labelledby="recent-saved">
          <div className="flex items-center justify-between gap-3">
            <h2 id="recent-saved" className="font-display text-xl">
              Recently saved
            </h2>
            <Link
              to="/saved"
              className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              All saved
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              <Bookmark className="mr-1 inline size-4" aria-hidden /> Nothing saved yet — tap “Save”
              on any expression during feedback and it lands here.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-3">
              {recent.map((e) => (
                <li key={e.id} className="rounded-2xl border border-border bg-card px-4 py-3">
                  <p className={cn("font-medium text-balance-wrap", e.lang === "ja" && "font-jp")}>
                    {e.text}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground text-balance-wrap">
                    {e.meaning}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 font-display text-2xl">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
