import { cn } from "@/lib/utils";

export function ScoreDial({
  value,
  delta,
  label,
  size = 112,
}: {
  value: number;
  delta?: number | null;
  label?: string;
  size?: number;
}) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  return (
    <div className="flex items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox="0 0 100 100"
          className="size-full -rotate-90"
          role="img"
          aria-label={`Score ${value} out of 100`}
        >
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-700"
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-display text-2xl font-semibold tabular-nums">{value}</span>
        </div>
      </div>
      <div>
        {label ? <p className="text-sm font-medium">{label}</p> : null}
        {typeof delta === "number" && delta !== 0 ? (
          <p
            className={cn("text-sm font-semibold", delta > 0 ? "text-success" : "text-destructive")}
          >
            {delta > 0 ? "+" : ""}
            {delta} vs. first attempt
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ScoreBar({
  label,
  value,
  previous,
}: {
  label: string;
  value: number;
  previous?: number | undefined;
}) {
  const delta = typeof previous === "number" ? value - previous : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium capitalize">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {value}
          {delta ? (
            <span
              className={cn("ml-1 font-semibold", delta > 0 ? "text-success" : "text-destructive")}
            >
              ({delta > 0 ? "+" : ""}
              {delta})
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700",
            value >= 75 ? "bg-success" : "bg-primary",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
