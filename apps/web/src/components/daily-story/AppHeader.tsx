import { Link, useRouterState } from "@tanstack/react-router";
import { List, Mic, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { SyncStatusBadge } from "./SyncStatusBadge";

export function DailyStoryHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-3xl items-center px-4">
        <Link to="/" className="flex items-center gap-2 rounded-md" aria-label="每日故事对话首页">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-tactile">
            <Mic className="size-4" aria-hidden />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">每日故事对话</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <SyncStatusBadge />
          <Link
            to="/"
            aria-current={pathname === "/" ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium",
              pathname === "/"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <List className="size-4" aria-hidden />
            我的对话
          </Link>
          <Link
            to="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium",
              pathname === "/settings"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <Settings className="size-4" aria-hidden />
            设置
          </Link>
        </div>
      </div>
    </header>
  );
}
