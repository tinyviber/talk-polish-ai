import { Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function ConversationMissing({ onNewConversation }: { onNewConversation: () => void }) {
  return (
    <section className="mx-auto max-w-xl rounded-3xl border border-border bg-card p-7 text-center shadow-lift">
      <h1 className="font-display text-2xl">找不到这个对话</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        链接可能已失效，或者这个对话还没有在本机创建。
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <Button variant="outline" className="rounded-full" asChild>
          <Link to="/">返回对话列表</Link>
        </Button>
        <Button className="rounded-full" onClick={onNewConversation}>
          新建对话
        </Button>
      </div>
    </section>
  );
}

export function ReviewProgress({ onCancel }: { onCancel: () => void }) {
  return (
    <section className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center text-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <p className="mt-3 text-sm">正在生成复盘…</p>
      <Button variant="outline" className="mt-5 rounded-full" onClick={onCancel}>
        取消
      </Button>
    </section>
  );
}

export function Loading({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <p className="mt-3 text-sm">{label}</p>
    </div>
  );
}
