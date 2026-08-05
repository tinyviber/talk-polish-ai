import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DurablePracticeWorkflow } from "@/lib/practice/workflow-store";

export function SubmissionFailure({
  workflow,
  error,
  onRetry,
  onAbandon,
  onStartOver,
}: {
  workflow: DurablePracticeWorkflow | null;
  error: string | null;
  onRetry: () => void;
  onAbandon: () => void;
  onStartOver: () => void;
}) {
  return (
    <section
      className="rounded-3xl border border-destructive/40 bg-destructive/5 p-6 shadow-lift"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div>
          <h1 className="font-display text-xl">This recording needs your decision</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Answer {workflow?.attemptIndex ?? "this"} could not be uploaded automatically. The saved
            recording remains available; choose how to continue.
          </p>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={onRetry}>
              <RefreshCw className="size-4" aria-hidden />
              Retry existing recording
            </Button>
            <Button variant="outline" onClick={onAbandon}>
              Abandon and record again
            </Button>
            <Button variant="ghost" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
