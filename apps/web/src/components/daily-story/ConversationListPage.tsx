import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Download, Loader2, MessageCircle, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportStorySessions,
  importStorySessions,
  listStorySessions,
  subscribeDailyStorage,
} from "@/features/daily-story/settings-repository";
import { createConversationId, type StorySessionSummary } from "@/features/daily-story/types";
import { DailyStoryHeader } from "./AppHeader";

function sessionLabel(session: StorySessionSummary) {
  if (session.phase === "review") return "已完成复盘";
  if (session.phase === "transcriptReady") return "等待确认转写";
  return "进行中";
}

function updatedLabel(value: string) {
  return value.slice(0, 16).replace("T", " ");
}

export function ConversationListPage() {
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [sessions, setSessions] = useState<StorySessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await listStorySessions();
        if (!alive) return;
        setSessions(next);
        setError(null);
      } catch (cause) {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : "无法读取本机对话。");
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const unsubscribe = subscribeDailyStorage((event) => {
      if (event.kind === "session") void load();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const startNewConversation = () => {
    void navigate({
      to: "/conversation/$conversationId",
      params: { conversationId: createConversationId() },
      search: { new: true },
    });
  };

  const exportConversations = async () => {
    setTransferBusy(true);
    setTransferStatus(null);
    setError(null);
    try {
      const json = await exportStorySessions();
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "daily-story-conversations-v2.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setTransferStatus("对话已导出。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法导出对话。");
    } finally {
      setTransferBusy(false);
    }
  };

  const importConversations = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setTransferBusy(true);
    setTransferStatus(null);
    setError(null);
    try {
      const result = await importStorySessions(await file.text());
      const next = await listStorySessions();
      setSessions(next);
      setTransferStatus(
        result.migratedLegacy
          ? `已导入 ${result.imported} 个对话，并迁移旧对话。`
          : `已导入 ${result.imported} 个对话。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法导入对话。现有对话未修改。");
    } finally {
      setTransferBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <DailyStoryHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-7 sm:py-10">
        <section className="mx-auto max-w-2xl">
          <p className="text-sm font-semibold text-primary">English only · 先说故事，再练表达</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-display text-4xl leading-tight sm:text-5xl">你的对话</h1>
              <p className="mt-3 text-muted-foreground">
                每个对话都有独立地址。打开旧链接，就能回到对应的练习，不会和其它标签页互相覆盖。
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                JSON 包含文字对话、转写和复盘内容，不包含 API 配置或录音；文件未加密，请妥善保存。
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void importConversations(event)}
              />
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => void exportConversations()}
                disabled={transferBusy}
              >
                <Download className="size-4" aria-hidden />
                导出
              </Button>
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => importInputRef.current?.click()}
                disabled={transferBusy}
              >
                <Upload className="size-4" aria-hidden />
                导入
              </Button>
              <Button className="rounded-full shadow-tactile" onClick={startNewConversation}>
                <Plus className="size-4" aria-hidden />
                新对话
              </Button>
            </div>
          </div>

          {transferStatus ? (
            <p className="mt-4 text-sm text-muted-foreground" role="status">
              {transferStatus}
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-6 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {loading ? (
            <div className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              正在读取对话…
            </div>
          ) : sessions.length ? (
            <div className="mt-8 space-y-3">
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  to="/conversation/$conversationId"
                  params={{ conversationId: session.id }}
                  className="group block rounded-3xl border border-border bg-card p-5 shadow-lift transition hover:-translate-y-0.5 hover:border-primary/40"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
                      <MessageCircle className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-medium leading-7">{session.storyZh}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {sessionLabel(session)} · {updatedLabel(session.updatedAt)}
                      </p>
                    </div>
                    <ArrowRight
                      className="mt-1 size-5 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary"
                      aria-hidden
                    />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="mt-8 rounded-3xl border border-dashed border-border bg-card p-8 text-center shadow-lift">
              <MessageCircle className="mx-auto size-8 text-primary" aria-hidden />
              <h2 className="mt-4 font-display text-2xl">还没有对话</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                创建一个新对话，开始今天的英语练习。
              </p>
              <Button className="mt-5 rounded-full" onClick={startNewConversation}>
                开始第一个对话
              </Button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
