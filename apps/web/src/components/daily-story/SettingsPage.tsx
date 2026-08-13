import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DailyStoryHeader } from "./AppHeader";
import { checkDailyProvider } from "@/features/daily-story/api";
import { getDashScopeFunAsrDirectSupport } from "@/features/daily-story/asr-direct";
import {
  CAPABILITY_LABELS,
  CUSTOM_PROVIDER,
  getProvider,
  getProviderCapability,
  normalizeProviderEndpoint,
  providerIdForEndpoint,
  PROVIDER_CATALOG,
  type ProviderId,
} from "@/features/daily-story/provider-catalog";
import {
  clearAllProviders,
  clearProvider,
  readProviderSettings,
  saveAsrDirectPreference,
  saveProvider,
} from "@/features/daily-story/persistence";
import {
  applyProviderSelection,
  hasEffectiveProviderEndpointChanged,
  isCurrentSettingsOperation,
  type SettingsDraft,
  type SettingsOperation,
} from "./settings-logic";
import type {
  AsrProvider,
  DailyCapability,
  ProviderSettings,
  TtsProvider,
} from "@/features/daily-story/types";

type Draft = SettingsDraft;
type Status = "idle" | "saving" | "checking" | "connected" | "failed";
type ProviderSelection = Record<DailyCapability, ProviderId>;
const DAILY_CAPABILITIES: DailyCapability[] = ["chat", "asr", "tts"];

function defaultDraft(capability: DailyCapability): Draft {
  const preset = getProviderCapability("openai-compatible", capability).preset;
  return {
    baseUrl: preset?.endpoint ?? "",
    apiKey: "",
    model: preset?.model ?? "",
    responseFormat: capability === "asr" ? (preset?.responseFormat ?? "") : "",
    voice: capability === "tts" ? (preset?.voice ?? "") : "",
  };
}

function toDraft(
  capability: DailyCapability,
  provider: ProviderSettings[DailyCapability] | undefined,
): Draft {
  if (!provider) return defaultDraft(capability);
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    responseFormat: "responseFormat" in provider ? (provider.responseFormat ?? "") : "",
    voice: "voice" in provider ? provider.voice : "",
  };
}

function providerFromDraft(capability: DailyCapability, draft: Draft, preset: ProviderId) {
  const shared = {
    baseUrl: normalizeProviderEndpoint(draft.baseUrl),
    apiKey: draft.apiKey,
    model: draft.model.trim(),
    ...(preset === "custom" ? {} : { preset }),
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
    chat: defaultDraft("chat"),
    asr: defaultDraft("asr"),
    tts: defaultDraft("tts"),
  });
  const [providerIds, setProviderIds] = useState<ProviderSelection>({
    chat: "openai-compatible",
    asr: "openai-compatible",
    tts: "openai-compatible",
  });
  const [status, setStatus] = useState<Record<DailyCapability, Status>>({
    chat: "idle",
    asr: "idle",
    tts: "idle",
  });
  const [asrDirectEnabled, setAsrDirectEnabled] = useState(false);
  const [visible, setVisible] = useState<Record<DailyCapability, boolean>>({
    chat: false,
    asr: false,
    tts: false,
  });
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef<Record<DailyCapability, SettingsOperation>>({
    chat: { operationId: 0, draftVersion: 0 },
    asr: { operationId: 0, draftVersion: 0 },
    tts: { operationId: 0, draftVersion: 0 },
  });

  const invalidateOperations = (capability: DailyCapability) => {
    const current = operationRef.current[capability];
    operationRef.current[capability] = {
      ...current,
      draftVersion: current.draftVersion + 1,
    };
  };
  const beginOperation = (capability: DailyCapability) => {
    const current = operationRef.current[capability];
    const captured = { ...current, operationId: current.operationId + 1 };
    operationRef.current[capability] = captured;
    return captured;
  };
  const isCurrentOperation = (capability: DailyCapability, captured: SettingsOperation) =>
    isCurrentSettingsOperation(operationRef.current[capability], captured);

  const load = async () => {
    try {
      const loaded = await readProviderSettings();
      setSettings(loaded);
      setDrafts({
        chat: toDraft("chat", loaded.chat),
        asr: toDraft("asr", loaded.asr),
        tts: toDraft("tts", loaded.tts),
      });
      setAsrDirectEnabled(loaded.local?.asrDirect ?? false);
      setProviderIds({
        chat: loaded.chat?.preset ?? providerIdForEndpoint("chat", loaded.chat?.baseUrl ?? ""),
        asr: loaded.asr?.preset ?? providerIdForEndpoint("asr", loaded.asr?.baseUrl ?? ""),
        tts: loaded.tts?.preset ?? providerIdForEndpoint("tts", loaded.tts?.baseUrl ?? ""),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取本机设置。");
    }
  };
  const selectProvider = (capability: DailyCapability, id: ProviderId) => {
    const provider = getProvider(id);
    const info = provider.capabilities[capability];
    if (!info.supported) return;
    invalidateOperations(capability);
    const currentProviderId = providerIds[capability];
    setProviderIds((current) => ({ ...current, [capability]: id }));
    setStatus((current) => ({ ...current, [capability]: "idle" }));
    const preset = info.preset;
    if (id === "custom") {
      setDrafts((current) => ({
        ...current,
        [capability]: applyProviderSelection(
          current[capability],
          capability,
          currentProviderId,
          id,
        ),
      }));
      return;
    }
    if (!preset) return;
    setDrafts((current) => ({
      ...current,
      [capability]: applyProviderSelection(current[capability], capability, currentProviderId, id),
    }));
  };
  useEffect(() => {
    void load();
  }, []);

  const update = (capability: DailyCapability, key: keyof Draft, value: string) => {
    invalidateOperations(capability);
    setDrafts((current) => ({
      ...current,
      [capability]: {
        ...current[capability],
        [key]: value,
        ...(key === "baseUrl" &&
        hasEffectiveProviderEndpointChanged(current[capability].baseUrl, value)
          ? { apiKey: "" }
          : {}),
      },
    }));
    if (key === "baseUrl") {
      setProviderIds((current) => ({
        ...current,
        [capability]: providerIdForEndpoint(capability, value),
      }));
    }
    setStatus((current) => ({ ...current, [capability]: "idle" }));
  };
  const save = async (capability: DailyCapability, checkAfter = true) => {
    const provider = providerFromDraft(capability, drafts[capability], providerIds[capability]);
    if (!provider) {
      setError(
        `${CAPABILITY_LABELS[capability]} 请填写 endpoint、API Key、model${capability === "tts" ? " 和 voice" : ""}。`,
      );
      return;
    }
    setError(null);
    const operation = beginOperation(capability);
    setStatus((current) => ({ ...current, [capability]: "saving" }));
    try {
      const saved = await saveProvider(capability, provider);
      if (!isCurrentOperation(capability, operation)) return;
      setSettings((current) => (current && current.revision > saved.revision ? current : saved));
      setDrafts((current) => ({
        ...current,
        [capability]: toDraft(capability, saved[capability]),
      }));
      setProviderIds((current) => ({
        ...current,
        [capability]: provider.preset ?? providerIdForEndpoint(capability, provider.baseUrl),
      }));
      setStatus((current) => ({ ...current, [capability]: checkAfter ? "checking" : "idle" }));
      if (!checkAfter) return;
      await checkDailyProvider({
        capability,
        provider,
        ...(capability === "asr" ? { directAsr: asrDirectEnabled } : {}),
      });
      if (isCurrentOperation(capability, operation))
        setStatus((current) => ({ ...current, [capability]: "connected" }));
    } catch (cause) {
      if (!isCurrentOperation(capability, operation)) return;
      setStatus((current) => ({ ...current, [capability]: "failed" }));
      setError(cause instanceof Error ? cause.message : "配置保存或连接检查失败。请重试。");
    }
  };
  const updateAsrDirect = async (enabled: boolean) => {
    invalidateOperations("asr");
    const support = getDashScopeFunAsrDirectSupport(
      {
        baseUrl: drafts.asr.baseUrl,
        model: drafts.asr.model,
      },
      enabled,
    );
    if (enabled && !support.supported) {
      setStatus((current) => ({ ...current, asr: "idle" }));
      setError(support.message);
      return;
    }
    const previous = asrDirectEnabled;
    setAsrDirectEnabled(enabled);
    setStatus((current) => ({ ...current, asr: "idle" }));
    try {
      const saved = await saveAsrDirectPreference(enabled);
      setSettings((current) => (current && current.revision > saved.revision ? current : saved));
      setError(null);
    } catch (cause) {
      setAsrDirectEnabled(previous);
      setError(cause instanceof Error ? cause.message : "无法保存 ASR 本地直连设置。");
    }
  };
  const clear = async (capability: DailyCapability) => {
    if (!window.confirm(`清除 ${capability.toUpperCase()} 配置？此浏览器将无法恢复该 Key。`))
      return;
    const operation = beginOperation(capability);
    try {
      const saved = await clearProvider(capability);
      if (!isCurrentOperation(capability, operation)) return;
      setSettings((current) => (current && current.revision > saved.revision ? current : saved));
      setDrafts((current) => ({ ...current, [capability]: defaultDraft(capability) }));
      setProviderIds((current) => ({ ...current, [capability]: "openai-compatible" }));
      setStatus((current) => ({ ...current, [capability]: "idle" }));
      setError(null);
    } catch (cause) {
      if (!isCurrentOperation(capability, operation)) return;
      setError(cause instanceof Error ? cause.message : "无法清除配置。");
    }
  };
  const clearAll = async () => {
    if (!window.confirm("清除全部 API 配置？当前浏览器将无法恢复这些 Key。")) return;
    const operations = DAILY_CAPABILITIES.map(
      (capability) => [capability, beginOperation(capability)] as const,
    );
    try {
      const saved = await clearAllProviders();
      if (!operations.every(([capability, operation]) => isCurrentOperation(capability, operation)))
        return;
      setSettings((current) => (current && current.revision > saved.revision ? current : saved));
      setDrafts({ chat: defaultDraft("chat"), asr: defaultDraft("asr"), tts: defaultDraft("tts") });
      setProviderIds({
        chat: "openai-compatible",
        asr: "openai-compatible",
        tts: "openai-compatible",
      });
      setAsrDirectEnabled(false);
      setStatus({ chat: "idle", asr: "idle", tts: "idle" });
      setError(null);
    } catch (cause) {
      if (!operations.every(([capability, operation]) => isCurrentOperation(capability, operation)))
        return;
      setError(cause instanceof Error ? cause.message : "无法清除配置。");
    }
  };

  return (
    <div className="min-h-screen">
      <DailyStoryHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-7 sm:py-10">
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
            <ProviderAvailability />
            <div className="mt-7 space-y-4">
              <ProviderCard
                capability="chat"
                title="Chat"
                hint="必需。用于开始、回复和复盘。"
                providerId={providerIds.chat}
                draft={drafts.chat}
                status={status.chat}
                configured={!!settings.chat}
                visible={visible.chat}
                onChange={update}
                onProviderChange={selectProvider}
                onSave={() => void save("chat")}
                onClear={() => void clear("chat")}
                onToggleVisible={() => setVisible((value) => ({ ...value, chat: !value.chat }))}
              />
              <ProviderCard
                capability="asr"
                title="ASR"
                hint="可选。配置后才能进行语音转写与朗读练习。"
                providerId={providerIds.asr}
                draft={drafts.asr}
                status={status.asr}
                configured={!!settings.asr}
                visible={visible.asr}
                onChange={update}
                onProviderChange={selectProvider}
                onSave={() => void save("asr")}
                onClear={() => void clear("asr")}
                onToggleVisible={() => setVisible((value) => ({ ...value, asr: !value.asr }))}
                asrDirectEnabled={asrDirectEnabled}
                asrDirectSupport={getDashScopeFunAsrDirectSupport({
                  baseUrl: drafts.asr.baseUrl,
                  model: drafts.asr.model,
                })}
                onAsrDirectToggle={(enabled) => void updateAsrDirect(enabled)}
              />
              <ProviderCard
                capability="tts"
                title="TTS"
                hint="可选。配置后复盘可听一遍。"
                providerId={providerIds.tts}
                draft={drafts.tts}
                status={status.tts}
                configured={!!settings.tts}
                visible={visible.tts}
                onChange={update}
                onProviderChange={selectProvider}
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

function ProviderAvailability() {
  return (
    <section
      aria-labelledby="provider-availability-title"
      className="mt-7 rounded-3xl border border-border bg-card/70 p-5 shadow-lift sm:p-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="provider-availability-title" className="font-display text-2xl">
            选择服务商
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            每项能力可以单独选择。选择后会填入推荐 endpoint 和 model，仍可手动修改。
          </p>
        </div>
        <span className="text-xs text-muted-foreground">首期支持 3 家</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {PROVIDER_CATALOG.map((provider) => (
          <div
            key={provider.id}
            className="rounded-2xl border border-border/80 bg-background/60 p-4"
          >
            <p className="font-medium">{provider.name}</p>
            <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
              {provider.description}
            </p>
            <CapabilityBadges capabilities={provider.capabilities} />
          </div>
        ))}
      </div>
    </section>
  );
}

function CapabilityBadges({
  capabilities,
  className = "",
}: {
  capabilities: Record<DailyCapability, { supported: boolean }>;
  className?: string;
}) {
  return (
    <div className={`mt-3 flex flex-wrap gap-1.5 ${className}`}>
      {(Object.keys(CAPABILITY_LABELS) as DailyCapability[]).map((capability) => (
        <span
          key={capability}
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            capabilities[capability].supported
              ? "bg-success/15 text-success"
              : "bg-secondary text-muted-foreground"
          }`}
        >
          {CAPABILITY_LABELS[capability]}
          {capabilities[capability].supported ? "" : " · 暂不支持"}
        </span>
      ))}
    </div>
  );
}

function ProviderCard({
  capability,
  title,
  hint,
  providerId,
  draft,
  status,
  configured,
  visible,
  onChange,
  onProviderChange,
  onSave,
  onClear,
  onToggleVisible,
  asrDirectEnabled = false,
  asrDirectSupport,
  onAsrDirectToggle,
}: {
  capability: DailyCapability;
  title: string;
  hint: string;
  providerId: ProviderId;
  draft: Draft;
  status: Status;
  configured: boolean;
  visible: boolean;
  onChange: (capability: DailyCapability, key: keyof Draft, value: string) => void;
  onProviderChange: (capability: DailyCapability, id: ProviderId) => void;
  onSave: () => void;
  onClear: () => void;
  onToggleVisible: () => void;
  asrDirectEnabled?: boolean;
  asrDirectSupport?: ReturnType<typeof getDashScopeFunAsrDirectSupport>;
  onAsrDirectToggle?: (enabled: boolean) => void;
}) {
  const busy = status === "saving" || status === "checking";
  const provider = getProvider(providerId);
  const capabilityInfo = provider.capabilities[capability];
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        </div>
        <StatusBadge status={status} configured={configured} />
      </div>
      <div className="mt-5 rounded-2xl border border-border/80 bg-background/60 p-4">
        <label className="block text-sm font-medium" htmlFor={`${capability}-provider`}>
          服务商
        </label>
        <Select
          value={providerId}
          onValueChange={(value) => onProviderChange(capability, value as ProviderId)}
        >
          <SelectTrigger
            id={`${capability}-provider`}
            aria-label={`${title} 服务商`}
            className="mt-2 h-11 bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_CATALOG.map((item) => {
              const supported = item.capabilities[capability].supported;
              return (
                <SelectItem key={item.id} value={item.id} disabled={!supported}>
                  <span className="flex items-center gap-2">
                    <span>{item.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {supported ? "可用" : `不支持 ${CAPABILITY_LABELS[capability]}`}
                    </span>
                  </span>
                </SelectItem>
              );
            })}
            <SelectItem value="custom">{CUSTOM_PROVIDER.name}</SelectItem>
          </SelectContent>
        </Select>
        {!capabilityInfo.supported ? (
          <p role="status" className="mt-3 rounded-xl bg-warn/10 px-3 py-2 text-xs leading-5">
            {capabilityInfo.note ?? `${provider.name} 不支持 ${CAPABILITY_LABELS[capability]}。`}
          </p>
        ) : (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            选择预设会填入推荐值；endpoint、model、Key 和能力字段都可继续编辑。
          </p>
        )}
      </div>
      <div className="mt-5 grid gap-3">
        <Field
          id={`${capability}-endpoint`}
          label="Base URL"
          value={draft.baseUrl}
          onChange={(value) => onChange(capability, "baseUrl", value)}
          placeholder="https://api.example.com/v1"
          autoComplete="url"
          helpText="保存时自动补齐 /v1，并去掉末尾斜杠。"
        />
        <Field
          id={`${capability}-api-key`}
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
          id={`${capability}-model`}
          label="Model"
          value={draft.model}
          onChange={(value) => onChange(capability, "model", value)}
          placeholder={capability === "asr" ? "whisper-1" : "模型名称"}
          autoComplete="off"
        />
        {capability === "asr" ? (
          <>
            <Field
              id={`${capability}-response-format`}
              label="Response format（可选）"
              value={draft.responseFormat}
              onChange={(value) => onChange(capability, "responseFormat", value)}
              placeholder="json"
              autoComplete="off"
            />
            <div className="rounded-2xl border border-warn/30 bg-warn/5 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">浏览器直连 DashScope Fun-ASR（本机 opt-in）</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    默认关闭。开启后，API Key 会从当前浏览器直接发送到 DashScope
                    provider，不再只走本站同源 proxy。仅支持公共 DashScope HTTPS endpoint
                    （dashscope.aliyuncs.com / dashscope-intl.aliyuncs.com）+ Fun-ASR HTTP
                    model；失败不会自动回退，必须手动关闭此开关后再改走 proxy。
                  </p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    保存并检查时，若此开关开启，会向 DashScope
                    发送一段小型测试音频，以验证实际浏览器直连 HTTP
                    能力（含网络/CORS）；这可能消耗一次 provider 请求或配额，且不会自动回退到
                    proxy。
                  </p>
                  {asrDirectSupport && !asrDirectSupport.supported ? (
                    <p
                      role="status"
                      className="mt-2 rounded-xl bg-warn/10 px-3 py-2 text-xs leading-5"
                    >
                      {asrDirectEnabled
                        ? `当前已保存的直连偏好不会生效。${asrDirectSupport.message}`
                        : asrDirectSupport.message}
                    </p>
                  ) : null}
                </div>
                <Switch
                  checked={asrDirectEnabled}
                  onCheckedChange={(checked) => onAsrDirectToggle?.(checked)}
                  aria-label="开启浏览器直连 DashScope Fun-ASR"
                />
              </div>
            </div>
          </>
        ) : null}
        {capability === "tts" ? (
          <Field
            id={`${capability}-voice`}
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
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
  helpText,
  action,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  autoComplete: string;
  helpText?: string;
  action?: ReactNode;
}) {
  return (
    <label className="block text-sm font-medium" htmlFor={id}>
      <span>{label}</span>
      <span className="relative mt-1.5 block">
        <Input
          id={id}
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
      {helpText ? (
        <span className="mt-1 block text-xs font-normal text-muted-foreground">{helpText}</span>
      ) : null}
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
