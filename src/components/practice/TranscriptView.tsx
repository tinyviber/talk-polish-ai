import type { Annotation } from "@/lib/practice/types";
import { cn } from "@/lib/utils";

const STYLE: Record<Annotation["kind"], string> = {
  ok: "",
  grammar: "bg-destructive/12 underline decoration-destructive decoration-wavy underline-offset-4",
  filler: "bg-warn/25 underline decoration-warn decoration-dotted underline-offset-4",
  word: "bg-accent/40 underline decoration-accent-foreground/50 underline-offset-4",
};

const LEGEND: { kind: Annotation["kind"]; label: string }[] = [
  { kind: "grammar", label: "Grammar" },
  { kind: "filler", label: "Hesitation" },
  { kind: "word", label: "Word choice" },
];

export function TranscriptView({ annotations, jp }: { annotations: Annotation[]; jp: boolean }) {
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {LEGEND.map((l) => (
          <li key={l.kind} className="flex items-center gap-1.5">
            <span className={cn("inline-block size-3 rounded-sm", STYLE[l.kind])} aria-hidden />
            {l.label}
          </li>
        ))}
      </ul>
      <p
        className={cn(
          "text-lg leading-relaxed text-balance-wrap",
          jp && "font-jp text-base leading-loose",
        )}
      >
        {annotations.map((a, i) => (
          <span key={i} className="inline">
            <span
              className={cn("rounded px-0.5", STYLE[a.kind])}
              title={a.note}
              tabIndex={a.note ? 0 : -1}
              aria-label={a.note ? `${a.text} — ${a.note}` : undefined}
            >
              {a.text}
            </span>{" "}
          </span>
        ))}
      </p>
      <ul className="mt-4 space-y-1.5">
        {annotations
          .filter((a) => a.note)
          .map((a, i) => (
            <li key={i} className="flex gap-2 text-sm text-muted-foreground text-balance-wrap">
              <span
                className={cn(
                  "shrink-0 rounded px-1 font-medium text-foreground",
                  STYLE[a.kind],
                  jp && "font-jp",
                )}
              >
                {a.text}
              </span>
              <span className={cn(jp && "font-jp")}>{a.note}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
