import type { Prompt } from "@/lib/practice/types";
import type { AppMode } from "@/lib/practice/mode";
import { AudioPlayButton } from "./AudioPlayButton";
import { cn } from "@/lib/utils";

export function PromptCard({
  prompt,
  compact,
  mode,
}: {
  prompt: Prompt;
  compact?: boolean;
  mode?: AppMode;
}) {
  const jp = prompt.lang === "ja";
  return (
    <article
      className={cn(
        "rounded-3xl border border-border bg-card p-5 shadow-lift sm:p-7",
        compact && "p-4 sm:p-5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
          {prompt.scenario}
        </span>
        <span className="text-xs font-medium text-muted-foreground">~{prompt.seconds}s answer</span>
      </div>

      <p className={cn("mt-3 text-sm text-muted-foreground text-balance-wrap", jp && "font-jp")}>
        {prompt.situation}
      </p>

      <blockquote
        className={cn(
          "mt-4 border-l-4 border-primary pl-4 font-display text-2xl leading-snug text-balance-wrap sm:text-3xl",
          jp && "font-jp text-xl leading-relaxed sm:text-2xl",
        )}
      >
        {prompt.question}
      </blockquote>
      {mode === "api" ? (
        <div className="mt-3 pl-4">
          <AudioPlayButton text={prompt.question} lang={prompt.lang} mode={mode} purpose="prompt" />
        </div>
      ) : null}
      {prompt.questionTranslation ? (
        <p className="mt-2 pl-4 text-sm italic text-muted-foreground text-balance-wrap">
          {prompt.questionTranslation}
        </p>
      ) : null}

      {!compact && (
        <ul className="mt-5 flex flex-wrap gap-2">
          {prompt.hints.map((h) => (
            <li
              key={h}
              className={cn(
                "rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground",
                jp && "font-jp",
              )}
            >
              {h}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
