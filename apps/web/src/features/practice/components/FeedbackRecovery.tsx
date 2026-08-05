import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DurablePracticeWorkflow } from "@/lib/practice/workflow-store";

export function FeedbackRecovery({
  workflow,
  error,
  onRetry,
  onStartOver,
}: {
  workflow: DurablePracticeWorkflow;
  error: string | null;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  return (
    <section
      className="rounded-3xl border border-warn/40 bg-warn/10 p-6 shadow-lift"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
        <div>
          <h1 className="font-display text-xl">Your recording is safe</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Answer {workflow.attemptIndex} uploaded already. Feedback could not load yet. Retry
            feedback below; your recording will not upload again.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {workflow.lang.toUpperCase()} · prompt {workflow.promptId}
          </p>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={onRetry}>
              <RefreshCw className="size-4" aria-hidden />
              Retry feedback
            </Button>
            <Button variant="outline" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
