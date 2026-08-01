import { Link, useRouterState } from "@tanstack/react-router";
import { Bookmark, Flame, Mic } from "lucide-react";
import { computeStreak, usePracticeStore } from "@/lib/practice/store";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/practice", label: "Practice" },
  { to: "/saved", label: "Saved" },
  { to: "/progress", label: "Progress" },
] as const;

export function AppHeader() {
  const { state } = usePracticeStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const streak = computeStreak(state.sessions);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-3 px-4">
        <Link to="/" className="flex items-center gap-2 rounded-md" aria-label="Kotoba Loop home">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-tactile">
            <Mic className="size-4" aria-hidden />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">Kotoba Loop</span>
        </Link>

        <nav aria-label="Main" className="ml-auto flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <span className="hidden sm:inline">{item.label}</span>
                <span className="sm:hidden">
                  {item.label === "Saved" ? (
                    <Bookmark className="size-4" aria-hidden />
                  ) : (
                    item.label
                  )}
                </span>
              </Link>
            );
          })}
        </nav>

        <div
          className="ml-1 flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-sm font-semibold"
          title={`${streak}-day streak`}
        >
          <Flame className="size-4 text-primary" aria-hidden />
          <span>{streak}</span>
          <span className="sr-only">day streak</span>
        </div>
      </div>
    </header>
  );
}
