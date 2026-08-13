import { Mic, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DAILY_STORY_TURN_MAX } from "@/features/daily-story/shared-types";
import type { DailyMessage } from "@/features/daily-story/types";
import type { RecordingDraft } from "@/features/daily-story/recording-drafts";
import { canCompleteRecordingDraft } from "@/features/daily-story/recording-draft-submit";
import type {
  RecorderDraft,
  RecorderInputDevice,
  MicrophoneTestStatus,
} from "@/lib/practice/useRecorder";
import { cn } from "@/lib/utils";

export function Conversation({
  messages,
  typed,
  onTypedChange,
  onSendTyped,
  canType,
  voiceEnabled,
  recording,
  recordingDraft,
  pendingSegment,
  draftError,
  draftSaving,
  recorderStatus,
  recorderError,
  recorderLevel,
  microphoneTestStatus,
  microphoneTestLevel,
  inputDevices,
  selectedInputDeviceId,
  onInputDeviceChange,
  onStartMicrophoneTest,
  onStopMicrophoneTest,
  seconds,
  onStartRecording,
  onStopRecording,
  onContinueRecording,
  onCompleteRecording,
  onDiscardRecording,
  onRetrySave,
  onDiscardPending,
  onCancelRecording,
  onResetRecorder,
  onFinish,
  finishEnabled,
  onNewStory,
}: {
  messages: DailyMessage[];
  typed: string;
  onTypedChange: (value: string) => void;
  onSendTyped: () => void;
  canType: boolean;
  voiceEnabled: boolean;
  recording: boolean;
  recordingDraft: RecordingDraft | null;
  pendingSegment: RecorderDraft | null;
  draftError: string | null;
  draftSaving: boolean;
  recorderStatus: string;
  recorderError: string | null;
  recorderLevel: number;
  microphoneTestStatus: MicrophoneTestStatus;
  microphoneTestLevel: number;
  inputDevices: RecorderInputDevice[];
  selectedInputDeviceId: string | null;
  onInputDeviceChange: (deviceId: string) => void;
  onStartMicrophoneTest: () => void;
  onStopMicrophoneTest: () => void;
  seconds: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onContinueRecording: () => void;
  onCompleteRecording: () => void;
  onDiscardRecording: () => void;
  onRetrySave: () => void;
  onDiscardPending: () => void;
  onCancelRecording: () => void;
  onResetRecorder: () => void;
  onFinish: () => void;
  finishEnabled: boolean;
  onNewStory: () => void;
}) {
  return (
    <section className="mx-auto max-w-2xl">
      <div className="space-y-3" aria-live="polite">
        <MessageList messages={messages} />
      </div>
      <div className="mt-6 rounded-3xl border border-border bg-card p-5 shadow-lift">
        {!voiceEnabled ? (
          <p className="mb-4 text-sm text-muted-foreground">
            语音聊天需配置 ASR。你仍可使用文字输入（备用，不是语音转写）。
          </p>
        ) : null}
        {recording ? (
          <div className="text-center">
            {recorderStatus === "recording" ? (
              <>
                <p className="font-mono text-3xl tabular-nums">
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                </p>
                <div
                  className="mx-auto mt-3 h-2 w-40 overflow-hidden rounded-full bg-secondary"
                  aria-label="麦克风输入"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={1}
                  aria-valuenow={recorderLevel}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-100"
                    style={{ width: `${Math.min(1, Math.max(0, recorderLevel)) * 100}%` }}
                  />
                </div>
                <Button
                  variant="destructive"
                  size="lg"
                  className="recording-ring mt-4 h-16 rounded-full px-8"
                  onClick={onStopRecording}
                >
                  <Square className="size-5" aria-hidden />
                  停止录音
                </Button>
              </>
            ) : recorderStatus === "requesting" ? (
              <div className="mt-4 flex flex-col items-center gap-2">
                <p className="text-sm text-muted-foreground">正在打开麦克风…</p>
                <Button variant="outline" size="sm" onClick={onCancelRecording}>
                  取消
                </Button>
              </div>
            ) : null}
            {recorderStatus === "recorded" || recordingDraft ? (
              <DraftActions
                draft={recordingDraft}
                saving={draftSaving}
                pendingSegment={pendingSegment}
                draftError={draftError}
                onContinue={onContinueRecording}
                onComplete={onCompleteRecording}
                onDiscard={onDiscardRecording}
                onRetrySave={onRetrySave}
                onDiscardPending={onDiscardPending}
              />
            ) : null}
            {recorderStatus === "denied" ? (
              <MicProblem error={recorderError} onRetry={onStartRecording} />
            ) : null}
          </div>
        ) : voiceEnabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <MicrophonePicker
              devices={inputDevices}
              selectedDeviceId={selectedInputDeviceId}
              onChange={(deviceId) => {
                onStopMicrophoneTest();
                onInputDeviceChange(deviceId);
              }}
              disabled={!canType}
              microphoneTestStatus={microphoneTestStatus}
              microphoneTestLevel={microphoneTestLevel}
              onStartMicrophoneTest={onStartMicrophoneTest}
              onStopMicrophoneTest={onStopMicrophoneTest}
            />
            <Button
              size="lg"
              className="h-14 rounded-full px-6 shadow-tactile"
              onClick={onStartRecording}
              disabled={!canType}
            >
              <Mic className="size-5" aria-hidden />
              开始说话
            </Button>
            {recorderStatus === "denied" ? (
              <MicProblem error={recorderError} onRetry={onStartRecording} />
            ) : null}
          </div>
        ) : null}
        <div className="mt-5 border-t border-border pt-5">
          <label className="text-sm font-medium" htmlFor="typed-fallback">
            文字输入（备用，不是语音转写）
          </label>
          <div className="mt-2 flex gap-2">
            <Textarea
              id="typed-fallback"
              value={typed}
              onChange={(event) => onTypedChange(event.target.value)}
              maxLength={DAILY_STORY_TURN_MAX}
              className="min-h-20 resize-none"
              disabled={!canType}
            />
            <Button
              size="icon"
              className="mt-auto size-11 shrink-0 rounded-full"
              onClick={onSendTyped}
              disabled={!canType || !typed.trim()}
              aria-label="发送文字输入"
            >
              <Send className="size-4" />
            </Button>
          </div>
          <p className="mt-2 text-right text-xs text-muted-foreground">
            {typed.length}/{DAILY_STORY_TURN_MAX}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="outline" className="rounded-full" onClick={onNewStory}>
          新故事
        </Button>
        <Button
          className="rounded-full shadow-tactile"
          onClick={onFinish}
          disabled={!finishEnabled}
        >
          结束并复盘
        </Button>
      </div>
      {recorderStatus === "recorded" ? (
        <button className="sr-only" onClick={onResetRecorder}>
          重置录音
        </button>
      ) : null}
    </section>
  );
}

function MicrophonePicker({
  devices,
  selectedDeviceId,
  onChange,
  disabled,
  microphoneTestStatus,
  microphoneTestLevel,
  onStartMicrophoneTest,
  onStopMicrophoneTest,
}: {
  devices: RecorderInputDevice[];
  selectedDeviceId: string | null;
  onChange: (deviceId: string) => void;
  disabled: boolean;
  microphoneTestStatus: MicrophoneTestStatus;
  microphoneTestLevel: number;
  onStartMicrophoneTest: () => void;
  onStopMicrophoneTest: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {devices.length ? (
        <label className="flex h-14 items-center gap-2 text-sm text-muted-foreground">
          <span>麦克风</span>
          <select
            aria-label="选择麦克风"
            className="h-14 w-56 rounded-full border border-border bg-background px-4 text-base text-foreground shadow-sm outline-none focus:ring-2 focus:ring-ring"
            value={selectedDeviceId ?? ""}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled || microphoneTestStatus === "requesting"}
          >
            {devices.map((device, index) => (
              <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
                {device.label || `麦克风 ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <MicrophoneTestButton
        disabled={disabled}
        status={microphoneTestStatus}
        level={microphoneTestLevel}
        onStart={onStartMicrophoneTest}
        onStop={onStopMicrophoneTest}
      />
    </div>
  );
}

const microphoneWaveform = [0.35, 0.55, 0.8, 1, 0.68, 0.48, 0.3];

function MicrophoneTestButton({
  disabled,
  status,
  level,
  onStart,
  onStop,
}: {
  disabled: boolean;
  status: MicrophoneTestStatus;
  level: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const isActive = status === "active";
  const isRequesting = status === "requesting";
  const hasSound = level > 0.035;
  const normalizedLevel = Math.min(1, Math.max(0, level * 1.8));

  return (
    <button
      type="button"
      className="flex h-14 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm text-foreground shadow-sm transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
      onClick={isActive ? onStop : onStart}
      disabled={disabled || isRequesting}
      aria-label={isActive ? "停止测试麦克风" : "测试说话"}
      title="测试当前选中的麦克风"
    >
      <span className="flex h-8 items-center gap-1" aria-hidden>
        {microphoneWaveform.map((shape, index) => {
          const barLevel = isActive
            ? Math.max(0.18, normalizedLevel * (0.55 + shape * 0.45))
            : 0.22 + shape * 0.16;
          const lit = isActive && hasSound && normalizedLevel >= shape * 0.22;
          return (
            <span
              key={index}
              className={cn(
                "block w-1.5 rounded-full transition-[height,background-color,opacity] duration-100",
                lit ? "bg-emerald-500" : "bg-border",
              )}
              style={{ height: `${Math.max(6, barLevel * 32)}px`, opacity: lit ? 1 : 0.8 }}
            />
          );
        })}
      </span>
      <span>
        {isRequesting ? "正在测试…" : isActive ? (hasSound ? "检测到声音" : "请说话") : "测试说话"}
      </span>
    </button>
  );
}

export function DraftActions({
  draft,
  saving,
  pendingSegment,
  draftError,
  onContinue,
  onComplete,
  onDiscard,
  onRetrySave,
  onDiscardPending,
}: {
  draft: RecordingDraft | null;
  saving: boolean;
  pendingSegment: RecorderDraft | null;
  draftError: string | null;
  onContinue: () => void;
  onComplete: () => void;
  onDiscard: () => void;
  onRetrySave: () => void;
  onDiscardPending: () => void;
}) {
  if (saving) {
    return <p className="mt-4 text-sm text-muted-foreground">正在保存录音片段…</p>;
  }
  if (!draft && !pendingSegment) return null;
  return (
    <div className="mt-4 rounded-2xl bg-secondary/70 p-4 text-left">
      {draft ? (
        <>
          <p className="font-medium">
            {draft.status === "completed" ? "转写已完成" : `已保存 ${draft.segments.length} 段录音`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {draft.status === "completed"
              ? `转写结果：${draft.transcript ?? "已保存"}`
              : draft.status === "failed" && draft.failureKind === "unknown"
                ? "上次提交结果未知。不会自动再次提交；如仍要重试，会发起新的 provider 请求。"
                : draft.status === "failed"
                  ? "上次提交明确失败。修正配置后可手动再试；再次提交会发起新的 provider 请求。"
                  : draft.status === "submitting" || draft.clientAttemptId
                    ? "录音提交状态已保存。为避免重复计费，不会再次自动发送。"
                    : `共 ${Math.round(draft.totalDurationSec)} 秒。可以继续录音，或合并后一次转写。`}
          </p>
          {draft.error ? <p className="mt-2 text-sm text-destructive">{draft.error}</p> : null}
          {draft.cleanupError ? (
            <p className="mt-2 text-sm text-destructive">本机副本清理失败：{draft.cleanupError}</p>
          ) : null}
        </>
      ) : null}
      {pendingSegment ? (
        <p className="mt-2 text-sm text-destructive">
          这一段录音尚未保存。请重试保存，或清空这一段；已有草稿不会被覆盖。
        </p>
      ) : null}
      {draftError && !pendingSegment && !draft?.error && !draft?.cleanupError ? (
        <p className="mt-2 text-sm text-destructive">{draftError}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {pendingSegment ? (
          <>
            <Button variant="outline" className="rounded-full" onClick={onRetrySave}>
              重试保存
            </Button>
            <Button variant="ghost" className="rounded-full" onClick={onDiscardPending}>
              清空这一段
            </Button>
          </>
        ) : null}
        {draft && draft.status !== "completed" && canCompleteRecordingDraft(draft) ? (
          <>
            <Button variant="outline" className="rounded-full" onClick={onContinue}>
              继续录音
            </Button>
            <Button className="rounded-full" onClick={onComplete}>
              {draft.status === "failed"
                ? draft.failureKind === "unknown"
                  ? "仍要重新提交"
                  : "再次转写"
                : "完成并转写"}
            </Button>
          </>
        ) : null}
        {draft ? (
          <Button variant="ghost" className="rounded-full" onClick={onDiscard}>
            清理本机录音
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function MicProblem({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="mt-4 rounded-2xl bg-secondary p-3 text-left text-sm text-muted-foreground">
      <p>无法使用麦克风。请在浏览器网站权限中允许麦克风，然后重试；或使用下方文字输入。</p>
      {error ? <p className="mt-1 text-xs">{error}</p> : null}
      <Button variant="outline" size="sm" className="mt-3 rounded-full" onClick={onRetry}>
        重试麦克风
      </Button>
    </div>
  );
}

export function MessageList({ messages }: { messages: DailyMessage[] }) {
  return (
    <>
      {messages.map((item) => (
        <article
          key={item.id}
          className={cn(
            "max-w-[88%] rounded-3xl px-4 py-3 leading-7 shadow-sm",
            item.role === "assistant"
              ? "mr-auto bg-card"
              : "ml-auto bg-primary text-primary-foreground",
          )}
        >
          {item.text}
        </article>
      ))}
    </>
  );
}
