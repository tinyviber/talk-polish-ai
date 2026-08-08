import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DailyStoryHeader } from "./AppHeader";
import { checkDailyProvider } from "@/features/daily-story/api";
import {
  clearAllProviders,
  clearProvider,
  readProviderSettings,
  saveProvider,
} from "@/features/daily-story/settings-repository";
import type {
  AsrProvider,
  DailyCapability,
  ProviderSettings,
  TtsProvider,
} from "@/features/daily-story/types";

type Draft = {
  baseUrl: string;
  apiKey: string;
  model: string;
  responseFormat: string;
  voice: string;
};
type Status = "idle" | "saving" | "checking" | "connected" | "failed";
const emptyDraft: Draft = { baseUrl: "", apiKey: "", model: "", responseFormat: "", voice: "" };

function toDraft(provider: ProviderSettings[DailyCapability] | undefined): Draft {
  if (!provider) return emptyDraft;
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    responseFormat: "responseFormat" in provider ? (provider.responseFormat ?? "") : "",
    voice: "voice" in provider ? provider.voice : "",
  };
}

function providerFromDraft(capability: DailyCapability, draft: Draft) {
  const shared = {
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey,
    model: draft.model.trim(),
  };
  if (!shared.baseUrl || !shared.apiKey || !shared.model) return null;
  if (capability === "asr") {
    return {
      ...shared,
      ...(draft.responseFormat.trim() ? { responseFormat: draft.responseFormat.trim() } : {}),
    } as AsrProvider;
  }
  if (capability === "tts") {
    if (!draft.voice.trim()) return null;
    return { ...shared, voice: draft.voice.trim() } as TtsProvider;
  }
  return shared;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<DailyCapability, Draft>>({
    chat: emptyDraft,
    asr: emptyDraft,
    tts: emptyDraft,
  });
  const [status, setStatus] = useState<Record<DailyCapability, Status>>({
    chat: "idle",
    asr: "idle",
    tts: "idle",
  });
  const [visible, setVisible] = useState<Record<DailyCapability, boolean>>({
    chat: false,
    asr: false,
    tts: false,
  });
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);

  const load = async () => {
    try {
      const loaded = await readProviderSettings();
      revisionRef.current = loaded.revision;
      setSettings(loaded);
      setDrafts({ chat: toDraft(loaded.chat), asr: toDraft(loaded.asr), tts: toDraft(loaded.tts) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取本机设置。");
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const update = (capability: DailyCapability, key: keyof Draft, value: string) => {
    setDrafts((current) => ({
      ...current,
      [capability]: { ...current[capability], [key]: value },
    }));
    setStatus((current) => ({ ...current, [capability]: "idle" }));
  };
  const save = async (capability: DailyCapability, checkAfter = true) => {
    const provider = providerFromDraft(capability, drafts[capability]);
    if (!provider) {
      setError(
        `${capability.toUpperCase()} 请填写服务地址、API Key、模型${capability === "tts" ? "和 voice" : ""}。`,
      );
      return;
    }
    setError(null);
    setStatus((current) => ({ ...current, [capability]: "saving" }));
    try {
      const saved = await saveProvider(capability, provider);
      revisionRef.current = saved.revision;
      setSettings(saved);
      setStatus((current) => ({ ...current, [capability]: checkAfter ? "checking" : "idle" }));
      if (!checkAfter) return;
      const checkedRevision = saved.revision;
      await checkDailyProvider({ capability, provider });
      if (revisionRef.current === checkedRevision)
        setStatus((current) => ({ ...current, [capability]: "connected" }));
    } catch (cause) {
      if (revisionRef.current === (settings?.revision ?? 0) + 1)
        setStatus((current) => ({ ...current, [capability]: "failed" }));
      setError(cause instanceof Error ? cause.message : "配置保存或连接检查失败。请重试。");
    }
  };
  const clear = async (capability: DailyCapability) => {
    if (!window.confirm(`清除 ${capability.toUpperCase()} 配置？此浏览器将无法恢复该 Key。`))
      return;
    try {
      const saved = await clearProvider(capability);
      revisionRef.current = saved.revision;
      setSettings(saved);
      setDrafts((current) => ({ ...current, [capability]: emptyDraft }));
      setStatus((current) => ({ ...current, [capability]: "idle" }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法清除配置。");
    }
  };
  const clearAll = async () => {
    if (!window.confirm("清除全部 API 配置？当前浏览器将无法恢复这些 Key。")) return;
    try {
      const saved = await clearAllProviders();
      revisionRef.current = saved.revision;
      setSettings(saved);
      setDrafts({ chat: emptyDraft, asr: emptyDraft, tts: emptyDraft });
      setStatus({ chat: "idle", asr: "idle", tts: "idle" });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法清除配置。");
    }
  };

  return (
    <div className="min-h-screen">
      <DailyStoryHeader />
      <main className="mx-auto w-full max-w-2xl px-4 py-7 sm:py-10">
        <p className="text-sm font-semibold text-primary">本机设置</p>
        <h1 className="mt-2 font-display text-4xl">API 配置</h1>
        <p className="mt-3 text-muted-foreground">
          API 配置保存在当前浏览器设备中。不会上传到故事记录，也不会同步到其它设备。
        </p>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {settings === null ? (
          <div className="mt-10 flex justify-center text-muted-foreground">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            <div className="mt-7 space-y-4">
              <ProviderCard
                capability="chat"
                title="Chat"
                hint="必需。用于开始、回复和复盘。"
                draft={drafts.chat}
                status={status.chat}
                configured={!!settings.chat}
                visible={visible.chat}
                onChange={update}
                onSave={() => void save("chat")}
                onClear={() => void clear("chat")}
                onToggleVisible={() => setVisible((value) => ({ ...value, chat: !value.chat }))}
              />
              <ProviderCard
                capability="asr"
                title="ASR"
                hint="可选。配置后才能进行语音转写与朗读练习。"
                draft={drafts.asr}
                status={status.asr}
                configured={!!settings.asr}
                visible={visible.asr}
                onChange={update}
                onSave={() => void save("asr")}
                onClear={() => void clear("asr")}
                onToggleVisible={() => setVisible((value) => ({ ...value, asr: !value.asr }))}
              />
              <ProviderCard
                capability="tts"
                title="TTS"
                hint="可选。配置后复盘可听一遍。"
                draft={drafts.tts}
                status={status.tts}
                configured={!!settings.tts}
                visible={visible.tts}
                onChange={update}
                onSave={() => void save("tts")}
                onClear={() => void clear("tts")}
                onToggleVisible={() => setVisible((value) => ({ ...value, tts: !value.tts }))}
              />
            </div>
            <Button
              variant="ghost"
              className="mt-5 text-destructive hover:text-destructive"
              onClick={() => void clearAll()}
            >
              <Trash2 className="size-4" />
              清除全部配置
            </Button>
          </>
        )}
      </main>
    </div>
  );
}

function ProviderCard({
  capability,
  title,
  hint,
  draft,
  status,
  configured,
  visible,
  onChange,
  onSave,
  onClear,
  onToggleVisible,
}: {
  capability: DailyCapability;
  title: string;
  hint: string;
  draft: Draft;
  status: Status;
  configured: boolean;
  visible: boolean;
  onChange: (capability: DailyCapability, key: keyof Draft, value: string) => void;
  onSave: () => void;
  onClear: () => void;
  onToggleVisible: () => void;
}) {
  const busy = status === "saving" || status === "checking";
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        </div>
        <StatusBadge status={status} configured={configured} />
      </div>
      <div className="mt-5 grid gap-3">
        <Field
          label="Base URL"
          value={draft.baseUrl}
          onChange={(value) => onChange(capability, "baseUrl", value)}
          placeholder="https://api.example.com/v1"
          autoComplete="url"
        />
        <Field
          label="API Key"
          type={visible ? "text" : "password"}
          value={draft.apiKey}
          onChange={(value) => onChange(capability, "apiKey", value)}
          placeholder="sk-…"
          autoComplete="off"
          action={
            <button
              type="button"
              className="text-muted-foreground"
              onClick={onToggleVisible}
              aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
            >
              {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          }
        />
        <Field
          label="Model"
          value={draft.model}
          onChange={(value) => onChange(capability, "model", value)}
          placeholder={capability === "asr" ? "whisper-1" : "模型名称"}
          autoComplete="off"
        />
        {capability === "asr" ? (
          <Field
            label="Response format（可选）"
            value={draft.responseFormat}
            onChange={(value) => onChange(capability, "responseFormat", value)}
            placeholder="json"
            autoComplete="off"
          />
        ) : null}
        {capability === "tts" ? (
          <Field
            label="Voice"
            value={draft.voice}
            onChange={(value) => onChange(capability, "voice", value)}
            placeholder="alloy"
            autoComplete="off"
          />
        ) : null}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button className="rounded-full" onClick={onSave} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {status === "checking" ? "连接检查中" : "保存并检查"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onClear} disabled={busy}>
          清除
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
  action,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  autoComplete: string;
  action?: ReactNode;
}) {
  return (
    <label className="block text-sm font-medium">
      <span>{label}</span>
      <span className="relative mt-1.5 block">
        <Input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="pr-10"
        />
        {action ? (
          <span className="absolute inset-y-0 right-3 grid place-items-center">{action}</span>
        ) : null}
      </span>
    </label>
  );
}

function StatusBadge({ status, configured }: { status: Status; configured: boolean }) {
  if (status === "connected")
    return (
      <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
        已连接
      </span>
    );
  if (status === "failed")
    return (
      <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
        检查失败
      </span>
    );
  if (status === "checking" || status === "saving")
    return (
      <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
        检查中
      </span>
    );
  return configured ? (
    <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
      已配置
    </span>
  ) : (
    <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
      未配置
    </span>
  );
}
