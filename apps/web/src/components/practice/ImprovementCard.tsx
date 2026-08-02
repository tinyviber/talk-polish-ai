import { ArrowRight } from "lucide-react";
import type { Improvement } from "@/lib/practice/types";
import type { AppMode } from "@/lib/practice/mode";
import type { Lang } from "@/lib/practice/types";
import { AudioPlayButton } from "./AudioPlayButton";
import { cn } from "@/lib/utils";

export function ImprovementCard({
  item,
  index,
  jp,
  lang,
  mode,
}: {
  item: Improvement;
  index: number;
  jp: boolean;
  lang: Lang;
  mode: AppMode;
}) {
  return (
    <li className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary font-semibold text-primary-foreground">
          {index}
        </span>
        <div className="min-w-0">
          <h3
            className={cn("font-display text-lg leading-snug text-balance-wrap", jp && "font-jp")}
          >
            {item.title}
          </h3>
          <p
            className={cn("mt-1 text-sm text-muted-foreground text-balance-wrap", jp && "font-jp")}
          >
            {item.detail}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <p
              className={cn(
                "rounded-xl bg-destructive/10 px-3 py-2 text-sm line-through decoration-destructive/60 text-balance-wrap",
                jp && "font-jp",
              )}
            >
              {item.before}
            </p>
            <ArrowRight className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
            <p
              className={cn(
                "rounded-xl bg-success/12 px-3 py-2 text-sm font-medium text-balance-wrap",
                jp && "font-jp",
              )}
            >
              {item.after}
            </p>
          </div>
          {mode === "api" ? (
            <div className="mt-3">
              <AudioPlayButton text={item.after} lang={lang} mode={mode} purpose="answer" />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
