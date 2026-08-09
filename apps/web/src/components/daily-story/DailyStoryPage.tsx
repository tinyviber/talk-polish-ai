import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, Mic, RotateCcw, Send, Square, Volume2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useRecorder,
  type MicrophoneTestStatus,
  type RecorderInputDevice,
} from "@/lib/practice/useRecorder";
import { cn } from "@/lib/utils";
import { DAILY_STORY_TURN_MAX, useDailyStoryController } from "@/features/daily-story/controller";
import { createConversationId, type ReviewSuggestion } from "@/features/daily-story/types";
import { DailyStoryHeader } from "./AppHeader";
import { finishConfirmationReducer, initialFinishConfirmationState } from "./finish-confirmation";

export const REVIEW_RETRY_LABEL = "再说一次";

function statusLabel(phase: string) {
  if (phase === "starting") return "正在开始对话…";
  if (phase === "transcribing" || phase === "readingAloudTranscribing") return "正在转写…";
  if (phase === "waitingForAi") return "正在回复…";
  if (phase === "reviewing") return "正在生成复盘…";
  return "处理中…";
}

export function DailyStoryPage({
  conversationId,
  isNew = false,
}: {
  conversationId: string;
  isNew?: boolean;
}) {
  const story = useDailyStoryController(conversationId, isNew);
  const recorder = useRecorder({ mode: "api" });
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [cachedAudioUrl, setCachedAudioUrl] = useState<string | null>(null);
  const [finishConfirmation, dispatchFinishConfirmation] = useReducer(
    finishConfirmationReducer,
    initialFinishConfirmationState,
  );
  const finishConfirmingRef = useRef(false);
  const sentRecordingRef = useRef<Blob | null>(null);
  const phase = story.state.phase;
  const transcribe = story.transcribe;
  const cancelRecording = story.cancelRecording;

  useEffect(() => {
    if (phase === "transcriptReady") {
      setTranscriptDraft(story.state.pendingTranscript?.text ?? "");
    }
  }, [phase, story.state.pendingTranscript?.id, story.state.pendingTranscript?.text]);

  useEffect(() => {
    const blob = story.cachedAudio?.blob;
    if (!blob) {
      setCachedAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setCachedAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [story.cachedAudio?.blob]);

  useEffect(() => {
    if (
      recorder.status !== "recorded" ||
      !recorder.audioBlob ||
      sentRecordingRef.current === recorder.audioBlob
    )
      return;
    const isConversation = phase === "recording";
    const isReadAloud = phase === "readingAloudRecording";
    if (!isConversation && !isReadAloud) return;
    sentRecordingRef.current = recorder.audioBlob;
    void transcribe(recorder.audioBlob, isReadAloud, recorder.seconds);
  }, [phase, recorder.audioBlob, recorder.seconds, recorder.status, transcribe]);

  useEffect(() => {
    if (phase === "recording" && recorder.status === "denied") cancelRecording();
  }, [cancelRecording, phase, recorder.status]);

  const beginConversationRecording = () => {
    sentRecordingRef.current = null;
    story.beginRecording();
    void recorder.start();
  };
  const beginReadAloud = (target: string) => {
    sentRecordingRef.current = null;
    story.beginReadAloud(target);
    void recorder.start();
  };
  const submitTyped = async () => {
    if (!typed.trim()) return;
    if (await story.sendTyped(typed)) setTyped("");
  };
  const start = () => {
    if (!story.capabilities.chat) {
      void navigate({ to: "/settings" });
      return;
    }
    story.start();
  };
  const startNewConversation = () => {
    void navigate({
      to: "/conversation/$conversationId",
      params: { conversationId: createConversationId() },
      search: { new: true },
    });
  };
  const requestFinish = () => {
    dispatchFinishConfirmation({ type: "open" });
  };
  const confirmFinish = () => {
    if (finishConfirmingRef.current) return;
    finishConfirmingRef.current = true;
    dispatchFinishConfirmation({ type: "confirm" });
    void story.finish().finally(() => {
      finishConfirmingRef.current = false;
      dispatchFinishConfirmation({ type: "settled" });
    });
  };

  return (
    <div className="min-h-screen">
      <DailyStoryHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-7 sm:py-10">
        {story.storageError ? (
          <p
            role="alert"
            className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {story.storageError}
          </p>
        ) : null}
        {story.cachedAudio?.status === "failed" && phase !== "error" ? (
          <div className="mb-4 rounded-2xl border border-border bg-card px-4 py-3 shadow-lift">
            {cachedAudioUrl ? (
              <audio className="mt-3 w-full" controls src={cachedAudioUrl} />
            ) : null}
            <Button
              className="mt-3 rounded-full"
              onClick={story.retryCachedAudio}
              disabled={!story.canEdit}
            >
              重试
            </Button>
          </div>
        ) : null}
        {story.conversationMissing ? (
          <ConversationMissing onNewConversation={startNewConversation} />
        ) : (
          <>
            {phase === "loading" ? <Loading /> : null}
            {phase === "compose" ? (
              <section className="mx-auto max-w-2xl">
                <p className="text-sm font-semibold text-primary">
                  English only · 先说故事，再练表达
                </p>
                <h1 className="mt-2 font-display text-4xl leading-tight sm:text-5xl">
                  今天，想聊什么？
                </h1>
                <p className="mt-3 text-muted-foreground">
                  用中文写一件真实的小事。系统会挑一个自然话题，用简单英语和你聊天，不会逐句翻译。
                </p>
                <label className="mt-7 block" htmlFor="story-zh">
                  <span className="sr-only">今天的中文故事</span>
                  <Textarea
                    id="story-zh"
                    value={story.state.draft}
                    onChange={(event) => story.setDraft(event.target.value.slice(0, 4_000))}
                    placeholder="例如：今天开会时，我想提出一个想法，但有点紧张……"
                    className="min-h-48 rounded-3xl bg-card p-5 text-base shadow-lift"
                    disabled={!story.canEdit}
                  />
                </label>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    size="lg"
                    className="h-14 rounded-full px-7 text-base shadow-tactile"
                    onClick={start}
                    disabled={!story.canEdit || !story.state.draft.trim()}
                  >
                    开始聊天
                  </Button>
                  {!story.capabilities.chat ? (
                    <span className="text-sm text-muted-foreground">
                      需先配置 Chat，点击开始将前往设置。
                    </span>
                  ) : null}
                  {story.capabilities.chat && !story.capabilities.asr ? (
                    <span className="text-sm text-muted-foreground">
                      语音聊天需配置 ASR；可使用文字输入。
                    </span>
                  ) : null}
                </div>
              </section>
            ) : null}
            {phase === "starting" ||
            phase === "transcribing" ||
            phase === "waitingForAi" ||
            phase === "reviewing" ||
            phase === "readingAloudTranscribing" ? (
              <Loading label={statusLabel(phase)} />
            ) : null}
            {phase === "chatting" || phase === "recording" ? (
              <Conversation
                messages={story.state.messages}
                typed={typed}
                onTypedChange={setTyped}
                onSendTyped={() => void submitTyped()}
                canType={story.capabilities.chat && story.canEdit && phase === "chatting"}
                voiceEnabled={story.capabilities.asr}
                recording={phase === "recording"}
                recorderStatus={recorder.status}
                recorderError={recorder.error}
                recorderLevel={recorder.level}
                microphoneTestStatus={recorder.microphoneTestStatus}
                microphoneTestLevel={recorder.microphoneTestLevel}
                inputDevices={recorder.inputDevices}
                selectedInputDeviceId={recorder.selectedInputDeviceId}
                onInputDeviceChange={recorder.selectInputDevice}
                onStartMicrophoneTest={() => void recorder.startMicrophoneTest()}
                onStopMicrophoneTest={recorder.stopMicrophoneTest}
                seconds={recorder.seconds}
                onStartRecording={beginConversationRecording}
                onStopRecording={() => void recorder.stop()}
                onCancelRecording={() => {
                  story.cancelRecording();
                  void recorder.stop();
                }}
                onResetRecorder={recorder.reset}
                onFinish={requestFinish}
                finishEnabled={
                  story.canEdit &&
                  story.state.messages.some((item) => item.role === "user" && item.text.trim()) &&
                  phase === "chatting"
                }
                onNewStory={startNewConversation}
              />
            ) : null}
            {phase === "transcriptReady" ? (
              <section className="mx-auto max-w-2xl rounded-3xl border border-border bg-card p-5 shadow-lift sm:p-7">
                <p className="text-sm font-semibold text-primary">语音转写完成</p>
                <h1 className="mt-2 font-display text-2xl">确认后发送</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  以下为语音转写结果，可修改后再发送。
                </p>
                <label className="mt-5 block" htmlFor="transcript-draft">
                  <span className="mb-2 block text-sm font-medium">转写内容（可编辑）</span>
                  <Textarea
                    id="transcript-draft"
                    value={transcriptDraft}
                    onChange={(event) => setTranscriptDraft(event.target.value.slice(0, 8_000))}
                    className="min-h-32 rounded-2xl bg-secondary/70 p-4 leading-7"
                    disabled={!story.canEdit}
                  />
                </label>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Button
                    className="rounded-full shadow-tactile"
                    onClick={() => story.sendAsr(transcriptDraft)}
                    disabled={!story.canEdit || !transcriptDraft.trim()}
                  >
                    <Send className="size-4" aria-hidden />
                    发送此转写
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-full"
                    onClick={() => story.saveAsrDraft(transcriptDraft)}
                    disabled={!story.canEdit || !transcriptDraft.trim()}
                  >
                    保存修改
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      story.reRecord();
                      recorder.reset();
                    }}
                    disabled={!story.canEdit}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    重录
                  </Button>
                </div>
              </section>
            ) : null}
            {phase === "review" || phase === "readingAloudRecording" ? (
              <Review
                suggestions={story.state.review?.suggestions ?? []}
                ttsEnabled={story.capabilities.tts}
                asrEnabled={story.capabilities.asr}
                readAloudRecording={phase === "readingAloudRecording"}
                recorderStatus={recorder.status}
                recorderError={recorder.error}
                readAloudTranscript={story.state.readAloudTranscript}
                readAloudTarget={story.state.readAloudTarget}
                onPlay={story.playTts}
                onReadAloud={beginReadAloud}
                onStop={() => void recorder.stop()}
                onCancel={() => {
                  story.resetReadAloud();
                  recorder.reset();
                }}
                onNewStory={startNewConversation}
                canEdit={story.canEdit}
              />
            ) : null}
            {phase === "error" ? (
              <section className="mx-auto max-w-xl rounded-3xl border border-destructive/30 bg-card p-6 text-center shadow-lift">
                <h1 className="font-display text-2xl">操作没有完成</h1>
                <p className="mt-3 text-sm text-muted-foreground">{story.state.error?.message}</p>
                {story.cachedAudio?.status === "failed" ? (
                  <>
                    {cachedAudioUrl ? (
                      <audio className="mt-5 w-full" controls src={cachedAudioUrl} />
                    ) : null}
                    <Button
                      className="mt-3 rounded-full"
                      onClick={story.retryCachedAudio}
                      disabled={!story.canEdit}
                    >
                      重试
                    </Button>
                  </>
                ) : null}
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {story.state.pendingTranscript?.source === "asr" ? (
                    <Button
                      className="rounded-full"
                      onClick={() => story.saveAsrDraft(transcriptDraft)}
                      disabled={!story.canEdit || !transcriptDraft.trim()}
                    >
                      保存英文转写
                    </Button>
                  ) : null}
                  {story.cachedAudio?.status !== "failed" ? (
                    <Button
                      className="rounded-full"
                      onClick={story.retry}
                      disabled={!story.canEdit}
                    >
                      重试
                    </Button>
                  ) : null}
                  <Button variant="outline" className="rounded-full" onClick={startNewConversation}>
                    新故事
                  </Button>
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>
      <AlertDialog
        open={finishConfirmation.open}
        onOpenChange={(open) => {
          if (!open) dispatchFinishConfirmation({ type: "cancel" });
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>结束这次对话？</AlertDialogTitle>
            <AlertDialogDescription>
              结束后会根据本次对话生成复盘建议。当前消息会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={finishConfirmation.submitting}>继续聊天</AlertDialogCancel>
            <AlertDialogAction onClick={confirmFinish} disabled={finishConfirmation.submitting}>
              {finishConfirmation.submitting ? "正在生成…" : "查看复盘"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConversationMissing({ onNewConversation }: { onNewConversation: () => void }) {
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

function Conversation({
  messages,
  typed,
  onTypedChange,
  onSendTyped,
  canType,
  voiceEnabled,
  recording,
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
  onCancelRecording,
  onResetRecorder,
  onFinish,
  finishEnabled,
  onNewStory,
}: {
  messages: { id: string; role: "assistant" | "user"; text: string }[];
  typed: string;
  onTypedChange: (value: string) => void;
  onSendTyped: () => void;
  canType: boolean;
  voiceEnabled: boolean;
  recording: boolean;
  recorderStatus: string;
  recorderError: string | null;
  recorderLevel: number;
  microphoneTestStatus: "idle" | "requesting" | "active" | "denied";
  microphoneTestLevel: number;
  inputDevices: RecorderInputDevice[];
  selectedInputDeviceId: string | null;
  onInputDeviceChange: (deviceId: string) => void;
  onStartMicrophoneTest: () => void;
  onStopMicrophoneTest: () => void;
  seconds: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onResetRecorder: () => void;
  onFinish: () => void;
  finishEnabled: boolean;
  onNewStory: () => void;
}) {
  return (
    <section className="mx-auto max-w-2xl">
      <div className="space-y-3" aria-live="polite">
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
                  停止并转写
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

function MicProblem({ error, onRetry }: { error: string | null; onRetry: () => void }) {
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

function Review({
  suggestions,
  ttsEnabled,
  asrEnabled,
  readAloudRecording,
  recorderStatus,
  recorderError,
  readAloudTranscript,
  readAloudTarget,
  onPlay,
  onReadAloud,
  onStop,
  onCancel,
  onNewStory,
  canEdit,
}: {
  suggestions: ReviewSuggestion[];
  ttsEnabled: boolean;
  asrEnabled: boolean;
  readAloudRecording: boolean;
  recorderStatus: string;
  recorderError: string | null;
  readAloudTranscript: string | null;
  readAloudTarget: string | null;
  onPlay: (text: string) => void;
  onReadAloud: (target: string) => void;
  onStop: () => void;
  onCancel: () => void;
  onNewStory: () => void;
  canEdit: boolean;
}) {
  const categoryLabel = {
    clarity: "表达清晰度",
    grammar: "语法",
    naturalness: "更自然",
  } as const;

  return (
    <section className="mx-auto max-w-2xl">
      <p className="text-sm font-semibold text-primary">本次复盘</p>
      <h1 className="mt-2 font-display text-3xl">值得记住的表达</h1>
      <p className="mt-2 text-sm text-muted-foreground">只保留高价值改进；没有也完全正常。</p>
      <div className="mt-6 space-y-3">
        {suggestions.length ? (
          suggestions.map((item) => (
            <article
              key={`${item.sourceTurnId}:${item.original}`}
              className="rounded-3xl border border-border bg-card p-5 shadow-lift"
            >
              <p className="text-sm text-muted-foreground line-through">{item.original}</p>
              <p className="mt-2 text-lg font-medium">{item.improved}</p>
              <p className="mt-2 text-xs font-medium text-primary">
                {categoryLabel[item.category]}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{item.explanationZh}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {ttsEnabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => onPlay(item.improved)}
                  >
                    <Volume2 className="size-4" />
                    听一遍
                  </Button>
                ) : null}
                {asrEnabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => onReadAloud(item.improved)}
                    disabled={!canEdit || readAloudRecording}
                  >
                    <Mic className="size-4" />
                    {REVIEW_RETRY_LABEL}
                  </Button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <p className="rounded-3xl border border-dashed border-border p-6 text-center text-muted-foreground">
            这次没有必须修改的表达。继续自然地说下去。
          </p>
        )}
      </div>
      <div className="mt-6 rounded-3xl border border-border bg-card p-5">
        {readAloudRecording ? (
          <div className="text-center">
            <p className="rounded-2xl bg-secondary p-3 text-left text-sm font-medium">
              {readAloudTarget}
            </p>
            <p className="text-sm text-muted-foreground">重新表达不评分，只用于核对转写。</p>
            {recorderStatus === "recording" ? (
              <Button
                variant="destructive"
                size="lg"
                className="recording-ring mt-4 h-14 rounded-full px-7"
                onClick={onStop}
              >
                <Square className="size-4" />
                停止并转写
              </Button>
            ) : recorderStatus === "requesting" ? (
              <p className="mt-4 text-sm text-muted-foreground">正在打开麦克风…</p>
            ) : null}
            <Button variant="ghost" size="sm" className="mt-3" onClick={onCancel}>
              取消
            </Button>
            {recorderStatus === "denied" ? (
              <MicProblem
                error={recorderError}
                onRetry={() => readAloudTarget && onReadAloud(readAloudTarget)}
              />
            ) : null}
          </div>
        ) : asrEnabled ? (
          <>
            <p className="font-medium">再说一次</p>
            <p className="mt-1 text-sm text-muted-foreground">
              每条改进句旁都可以重新表达。不会评分，也不会改变本次复盘。
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">配置 ASR 后可开启朗读练习。</p>
        )}
        {readAloudTranscript ? (
          <p className="mt-4 rounded-2xl bg-secondary p-3 text-sm">
            {readAloudTarget ? `目标表达：${readAloudTarget}。` : ""}本次表达转写：
            {readAloudTranscript}
          </p>
        ) : null}
      </div>
      <Button className="mt-6 rounded-full shadow-tactile" onClick={onNewStory}>
        开始新故事
      </Button>
    </section>
  );
}

function Loading({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <p className="mt-3 text-sm">{label}</p>
    </div>
  );
}
