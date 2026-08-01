import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/practice/AppHeader";
import { computeStreak, usePracticeStore } from "@/lib/practice/store";
import { getPrompt } from "@/lib/practice/mockData";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/progress")({
  head: () => ({
    meta: [
      { title: "Your progress — Kotoba Loop" },
      {
        name: "description",
        content: "Consistency and second-attempt improvement across your speaking sessions.",
      },
      { property: "og:title", content: "Your progress — Kotoba Loop" },
      {
        property: "og:description",
        content: "Consistency and second-attempt improvement across your speaking sessions.",
      },
    ],
  }),
  component: Progress,
});

function last14() {
  const days: string[] = [];
  const d = new Date();
  for (let i = 13; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    days.push(x.toISOString().slice(0, 10));
  }
  return days;
}

function Progress() {
  const { ready, state } = usePracticeStore();
  const sessions = state.sessions;
  const streak = computeStreak(sessions);
  const improved = sessions.filter((s) => s.second !== null);
  const avgGain =
    improved.length > 0
      ? Math.round(improved.reduce((a, s) => a + ((s.second ?? 0) - s.first), 0) / improved.length)
      : null;
  const active = new Set(sessions.map((s) => s.date));
  const days = last14();

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
        <h1 className="font-display text-3xl sm:text-4xl">Your progress</h1>
        <p className="mt-2 text-muted-foreground">
          Speaking improves with reps, not with charts. Here are the two numbers worth watching.
        </p>

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-3xl border border-border bg-card p-5 shadow-lift">
            <p className="text-sm text-muted-foreground">Current streak</p>
            <p className="font-display text-4xl">{streak}<span className="ml-1 text-base text-muted-foreground">days</span></p>
            <div className="mt-4 flex gap-1.5" aria-label="Last 14 days of practice">
              {days.map((d) => (
                <span
                  key={d}
                  title={d}
                  className={cn(
                    "h-8 flex-1 rounded-md",
                    active.has(d) ? "bg-primary" : "bg-secondary",
                  )}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Last 14 days</p>
          </div>

          <div className="rounded-3xl border border-border bg-card p-5 shadow-lift">
            <p className="text-sm text-muted-foreground">Average second-attempt gain</p>
            <p className="font-display text-4xl">
              {avgGain === null ? "—" : `+${avgGain}`}
              <span className="ml-1 text-base text-muted-foreground">points</span>
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              {avgGain === null
                ? "Complete a second attempt to start tracking improvement."
                : `Across ${improved.length} session${improved.length === 1 ? "" : "s"} where you recorded twice.`}
            </p>
          </div>
        </section>

        <section className="mt-8" aria-labelledby="history">
          <h2 id="history" className="font-display text-xl">
            Recent sessions
          </h2>
          {!ready ? (
            <div className="mt-3 h-20 animate-pulse rounded-2xl bg-secondary" />
          ) : sessions.length === 0 ? (
            <div className="mt-3 rounded-3xl border border-dashed border-border p-8 text-center">
              <p className="font-display text-lg">No sessions yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Your first round takes about 3 minutes.</p>
              <Button asChild className="mt-4 rounded-full shadow-tactile">
                <Link to="/practice">Start practising</Link>
              </Button>
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {sessions.map((s) => {
                const p = getPrompt(s.promptId);
                const gain = s.second === null ? null : s.second - s.first;
                return (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border bg-card px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className={cn("font-medium text-balance-wrap", s.lang === "ja" && "font-jp")}>
                        {p.scenario}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.date} · {s.lang === "ja" ? "日本語" : "English"}
                      </p>
                    </div>
                    <p className="tabular-nums text-sm">
                      {s.first}
                      {s.second !== null ? ` → ${s.second}` : ""}
                    </p>
                    {gain !== null ? (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-semibold",
                          gain > 0 ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {gain > 0 ? `+${gain}` : gain}
                      </span>
                    ) : (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                        1 attempt
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
