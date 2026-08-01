import { Bookmark, BookmarkCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Expression } from "@/lib/practice/types";
import { cn } from "@/lib/utils";

export function ExpressionRow({
  expression,
  saved,
  onToggle,
}: {
  expression: Expression;
  saved: boolean;
  onToggle: () => void;
}) {
  const jp = expression.lang === "ja";
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium text-balance-wrap", jp && "font-jp")}>{expression.text}</p>
        {expression.reading ? (
          <p className="font-jp text-xs text-muted-foreground text-balance-wrap">
            {expression.reading}
          </p>
        ) : null}
        <p className="mt-0.5 text-sm text-muted-foreground text-balance-wrap">{expression.meaning}</p>
      </div>
      <Button
        variant={saved ? "secondary" : "outline"}
        size="sm"
        onClick={onToggle}
        aria-pressed={saved}
        aria-label={saved ? `Remove ${expression.text} from saved` : `Save ${expression.text}`}
        className="shrink-0"
      >
        {saved ? (
          <BookmarkCheck className="size-4 text-primary" aria-hidden />
        ) : (
          <Bookmark className="size-4" aria-hidden />
        )}
        <span className="hidden sm:inline">{saved ? "Saved" : "Save"}</span>
      </Button>
    </li>
  );
}
