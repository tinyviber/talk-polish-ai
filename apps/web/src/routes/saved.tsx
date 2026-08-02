import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/practice/AppHeader";
import { ExpressionRow } from "@/components/practice/ExpressionRow";
import { usePracticeStore } from "@/lib/practice/store";
import type { Lang } from "@/lib/practice/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/saved")({
  head: () => ({
    meta: [
      { title: "Saved expressions — Kotoba Loop" },
      {
        name: "description",
        content: "Every phrase you kept from your speaking sessions, ready for a quick review.",
      },
      { property: "og:title", content: "Saved expressions — Kotoba Loop" },
      {
        property: "og:description",
        content: "Every phrase you kept from your speaking sessions, ready for a quick review.",
      },
    ],
  }),
  component: Saved,
});

type Filter = "all" | Lang;

function Saved() {
  const { ready, state, mode, error, toggleSaved } = usePracticeStore();
  const [filter, setFilter] = useState<Filter>("all");

  const items = state.saved.filter((e) => filter === "all" || e.lang === filter);

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {mode} mode
        </p>
        <h1 className="font-display text-3xl sm:text-4xl">Saved expressions</h1>
        <p className="mt-2 text-muted-foreground">
          Phrases you kept from feedback. Say each one out loud once — that's the whole review.
        </p>

        <div className="mt-5 flex items-center gap-1 rounded-full border border-border bg-card p-1 w-fit">
          {(["all", "en", "ja"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "all" ? "All" : f === "en" ? "English" : "日本語"}
            </button>
          ))}
        </div>

        {error ? (
          <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!ready ? (
          <div className="mt-6 h-24 animate-pulse rounded-2xl bg-secondary" />
        ) : !state.onboarded ? (
          <div className="mt-6 rounded-3xl border border-dashed border-border p-8 text-center">
            <p className="font-display text-lg">Choose a language first</p>
            <Button asChild className="mt-4 rounded-full shadow-tactile">
              <Link to="/">Go home</Link>
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="mt-6 rounded-3xl border border-dashed border-border p-8 text-center">
            <p className="font-display text-lg">Nothing saved yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              During feedback, tap “Save” next to any expression and it will show up here.
            </p>
            <Button asChild className="mt-4 rounded-full shadow-tactile">
              <Link to="/practice">Start a session</Link>
            </Button>
          </div>
        ) : (
          <ul className="mt-6 space-y-2">
            {items.map((e) => (
              <ExpressionRow key={e.id} expression={e} saved onToggle={() => void toggleSaved(e)} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
