import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcw, Send } from "lucide-react";
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
import { useRecorder, type RecorderDraft } from "@/lib/practice/useRecorder";
import { mergeRecordedAudio } from "@/lib/practice/audio-format";
import { useDailyStory } from "@/features/daily-story/application/daily-story-runtime";
import {
  canCompleteRecordingDraft,
  submitRecordingDraft,
} from "@/features/daily-story/recording-draft-submit";
import {
  appendRecordingDraftSegment,
  getRecordingDrafts,
  markRecordingDraftCleanupFailed,
  markRecordingDraftCompleted,
  markRecordingDraftSubmitting,
  markRecordingDraftFailed,
  removeRecordingDraft,
  type RecordingDraft,
} from "@/features/daily-story/recording-drafts";
import type { DailyStoryAudioPurpose } from "@/features/daily-story/audio-outbox";
import { createConversationId } from "@/features/daily-story/types";
import { deriveStableDailyStoryTitle } from "@kotoba/contracts";
import { DailyStoryHeader } from "./AppHeader";
import { resolveDailyStoryErrorRetryUi } from "./daily-story-error-retry";
import { finishConfirmationReducer, initialFinishConfirmationState } from "./finish-confirmation";
import { resolveRecordingDraftPurpose } from "./recording-draft-purpose";
import { Conversation, DraftActions } from "./ui/Conversation";
import { ConversationMissing, Loading, ReviewProgress } from "./ui/Status";
import { Review, ReviewTabs, type ReviewProps } from "./ui/Review";

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
  const story = useDailyStory(conversationId, isNew);
  const commands = story.commands;
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [cachedAudioUrl, setCachedAudioUrl] = useState<string | null>(null);
  const [conversationAudioUrls, setConversationAudioUrls] = useState<Record<string, string>>({});
  const [reviewTab, setReviewTab] = useState<"conversation" | "suggestions" | "score">(
    "conversation",
  );
  const [recordingDrafts, setRecordingDrafts] = useState<
    Record<DailyStoryAudioPurpose, RecordingDraft | null>
  >({ conversation: null, readAloud: null });
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pendingSegment, setPendingSegment] = useState<RecorderDraft | null>(null);
  const [finishConfirmation, dispatchFinishConfirmation] = useReducer(
    finishConfirmationReducer,
    initialFinishConfirmationState,
  );
  const finishConfirmingRef = useRef(false);
  const sentRecordingRef = useRef<Blob | null>(null);
  const phase = story.state.phase;
  const transcribe = commands.transcribe;
  const cancelRecording = commands.cancelRecording;
  const draftAppendRef = useRef<Blob | null>(null);
  const draftActionRef = useRef(false);
  const recordingPurposeRef = useRef<DailyStoryAudioPurpose | null>(null);
  const phaseRef = useRef(phase);
  const mountedRef = useRef(true);
  phaseRef.current = phase;

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const appendDraftSegment = useCallback(
    async (segment: RecorderDraft) => {
      const purpose = resolveRecordingDraftPurpose(recordingPurposeRef.current, phaseRef.current);
      if (!purpose) {
        throw new Error("录音目的不明确，未保存录音片段。");
      }
      sentRecordingRef.current = segment.blob;
      draftAppendRef.current = segment.blob;
      if (mountedRef.current) {
        setDraftSaving(true);
        setDraftError(null);
      }
      try {
        const draft = await appendRecordingDraftSegment({
          conversationId,
          purpose,
          ...(purpose === "readAloud" && story.state.readAloudTarget
            ? { readAloudTarget: story.state.readAloudTarget }
            : {}),
          blob: segment.blob,
          mimeType: segment.mimeType || segment.blob.type || "audio/webm",
          durationSec: Math.max(0.01, segment.durationSec),
          segmentId: `${purpose}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });
        if (mountedRef.current) {
          setRecordingDrafts((current) => ({ ...current, [purpose]: draft }));
          setPendingSegment(null);
          setDraftError(null);
          commands.recordingDraftReady(purpose === "readAloud");
        }
      } catch (error: unknown) {
        if (mountedRef.current) {
          setPendingSegment(segment);
          const message = error instanceof Error ? error.message : "录音未能保存到本机。";
          setDraftError(message);
        }
        throw error;
      } finally {
        if (mountedRef.current) setDraftSaving(false);
      }
    },
    [conversationId, story],
  );

  const recorder = useRecorder({ mode: "api", onInterruptedRecording: appendDraftSegment });

  const conversationDraft = recordingDrafts.conversation;
  const readAloudDraft = recordingDrafts.readAloud;
  const showConversationDraft =
    phase === "chatting" ||
    phase === "recording" ||
    phase === "recordingDraftReady" ||
    (phase === "error" && story.state.error?.resumePhase === "chatting");
  const showReadAloudDraft =
    phase === "review" ||
    phase === "readingAloudRecording" ||
    phase === "readingAloudDraftReady" ||
    (phase === "error" && story.state.error?.resumePhase === "review");
  const activeDraft =
    showReadAloudDraft && readAloudDraft
      ? readAloudDraft
      : showConversationDraft
        ? conversationDraft
        : null;
  const errorPanelNeedsOwnDraftActions =
    phase === "error" &&
    Boolean(activeDraft) &&
    !(
      (activeDraft?.purpose === "conversation" && showConversationDraft) ||
      (activeDraft?.purpose === "readAloud" && showReadAloudDraft)
    );
  const errorRetryUi = resolveDailyStoryErrorRetryUi({
    ...(story.state.error?.kind ? { errorKind: story.state.error.kind } : {}),
    activeDraft,
    cachedAudioFailed: story.cachedAudio?.status === "failed",
  });

  useEffect(() => {
    let alive = true;
    setRecordingDrafts({ conversation: null, readAloud: null });
    void getRecordingDrafts(conversationId)
      .then((drafts) => {
        if (alive) setRecordingDrafts(drafts);
      })
      .catch((error: unknown) => {
        if (alive) setDraftError(error instanceof Error ? error.message : "录音草稿读取失败。");
      });
    return () => {
      alive = false;
    };
  }, [conversationId]);

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
    const urls = Object.fromEntries(
      story.conversationAudios.map((audio) => [
        audio.clientAttemptId,
        URL.createObjectURL(audio.blob),
      ]),
    );
    setConversationAudioUrls(urls);
    return () => {
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [story.conversationAudios]);

  useEffect(() => {
    if (
      recorder.status !== "recorded" ||
      !recorder.audioBlob ||
      sentRecordingRef.current === recorder.audioBlob ||
      draftAppendRef.current === recorder.audioBlob
    )
      return;
    if (phase !== "recording" && phase !== "readingAloudRecording") return;
    recordingPurposeRef.current = phase === "readingAloudRecording" ? "readAloud" : "conversation";
    void appendDraftSegment({
      blob: recorder.audioBlob,
      durationSec: recorder.seconds,
      mimeType: recorder.audioBlob.type || "audio/webm",
      reason: "manual",
    }).catch(() => {});
  }, [appendDraftSegment, phase, recorder.audioBlob, recorder.seconds, recorder.status]);

  useEffect(() => {
    if (
      (phase === "recording" || phase === "readingAloudRecording") &&
      recorder.status === "denied"
    )
      cancelRecording();
  }, [cancelRecording, phase, recorder.status]);

  const beginConversationRecording = () => {
    sentRecordingRef.current = null;
    draftAppendRef.current = null;
    recordingPurposeRef.current = "conversation";
    commands.beginRecording();
    void recorder.start();
  };
  const beginReadAloud = (target: string) => {
    sentRecordingRef.current = null;
    draftAppendRef.current = null;
    recordingPurposeRef.current = "readAloud";
    commands.beginReadAloud(target);
    void recorder.start();
  };
  const continueDraftRecording = (readAloud = false) => {
    sentRecordingRef.current = null;
    draftAppendRef.current = null;
    recordingPurposeRef.current = readAloud ? "readAloud" : "conversation";
    commands.continueRecording(readAloud);
    void recorder.start();
  };
  const retryPendingSegment = () => {
    if (draftActionRef.current || !pendingSegment) return;
    void appendDraftSegment(pendingSegment).catch(() => {});
  };
  const discardPendingSegment = () => {
    if (draftActionRef.current) return;
    setPendingSegment(null);
    setDraftError(null);
    sentRecordingRef.current = null;
    draftAppendRef.current = null;
    commands.cancelRecording();
    recorder.reset();
  };
  const discardDraft = async (readAloud = false) => {
    if (draftActionRef.current) return;
    draftActionRef.current = true;
    const purpose: DailyStoryAudioPurpose = readAloud ? "readAloud" : "conversation";
    try {
      await removeRecordingDraft(conversationId, purpose);
      setRecordingDrafts((current) => ({ ...current, [purpose]: null }));
      setDraftError(null);
      commands.cancelRecording();
      recorder.reset();
      recordingPurposeRef.current = null;
    } catch (error) {
      const text = error instanceof Error ? error.message : "录音清理失败，请重试。";
      await markRecordingDraftCleanupFailed(conversationId, purpose, text).catch(() => {});
      setRecordingDrafts((current) => ({
        ...current,
        [purpose]: current[purpose]
          ? { ...current[purpose]!, cleanupError: text }
          : current[purpose],
      }));
      setDraftError(`录音已处理，清理本机副本失败：${text}`);
    } finally {
      draftActionRef.current = false;
    }
  };
  const completeDraft = async (readAloud = false) => {
    const purpose: DailyStoryAudioPurpose = readAloud ? "readAloud" : "conversation";
    const draft = recordingDrafts[purpose];
    if (draftActionRef.current || !canCompleteRecordingDraft(draft)) return;
    if (!draft) return;
    draftActionRef.current = true;
    try {
      const result = await submitRecordingDraft({
        conversationId,
        draft,
        phase,
        mergeRecordedAudio,
        transcribe,
        markSubmitting: markRecordingDraftSubmitting,
        markFailed: markRecordingDraftFailed,
        markCompleted: markRecordingDraftCompleted,
        markCleanupFailed: markRecordingDraftCleanupFailed,
        removeDraft: removeRecordingDraft,
        onDraftChange: (next) => setRecordingDrafts((current) => ({ ...current, [purpose]: next })),
      });
      if (result.outcome === "completed") {
        setDraftError(
          result.cleanupError ? `转写已完成，录音副本清理失败：${result.cleanupError}` : null,
        );
      } else if (result.outcome === "failed") {
        setDraftError(result.error);
      }
    } finally {
      draftActionRef.current = false;
    }
  };
  const submitTyped = async () => {
    if (!typed.trim()) return;
    if (await commands.sendTyped(typed)) setTyped("");
  };
  const start = () => {
    if (!story.capabilities.chat) {
      void navigate({ to: "/settings" });
      return;
    }
    commands.start();
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
    void commands.finish().finally(() => {
      finishConfirmingRef.current = false;
      dispatchFinishConfirmation({ type: "settled" });
    });
  };

  const reviewProps: ReviewProps = {
    review: story.state.review,
    suggestions: story.state.review?.suggestions ?? [],
    reviewBusy: phase === "reviewing",
    reviewError: story.state.error?.kind === "review" ? story.state.error.message : null,
    onReReview: () => void commands.finish(),
    onCancelReview: commands.cancel,
    onRetryReview: commands.retry,
    ttsEnabled: story.capabilities.tts,
    asrEnabled: story.capabilities.asr,
    readAloudRecording:
      phase === "readingAloudRecording" ||
      phase === "readingAloudDraftReady" ||
      Boolean(readAloudDraft),
    recordingDraft: readAloudDraft,
    pendingSegment,
    draftError,
    draftSaving,
    recorderStatus: recorder.status,
    recorderError: recorder.error,
    readAloudTranscript: story.state.readAloudTranscript,
    readAloudTarget: readAloudDraft?.readAloudTarget ?? story.state.readAloudTarget,
    onPlay: commands.playTts,
    onReadAloud: beginReadAloud,
    onStop: () => void recorder.stop(),
    onContinueRecording: () => continueDraftRecording(true),
    onCompleteRecording: () => void completeDraft(true),
    onDiscardRecording: () => void discardDraft(true),
    onRetrySave: retryPendingSegment,
    onDiscardPending: discardPendingSegment,
    onCancel: () => {
      commands.resetReadAloud();
      recorder.reset();
    },
    onNewStory: startNewConversation,
    canEdit: story.canEdit,
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
        {draftError ? (
          <p
            role="alert"
            className="mb-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {draftError}
          </p>
        ) : null}
        {story.cachedAudio?.status === "failed" && phase !== "error" ? (
          <div className="mb-4 rounded-2xl border border-border bg-card px-4 py-3 shadow-lift">
            {cachedAudioUrl ? (
              <audio className="mt-3 w-full" controls src={cachedAudioUrl} />
            ) : null}
            <Button
              className="mt-3 rounded-full"
              onClick={commands.retryCachedAudio}
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
            {phase !== "compose" && phase !== "loading" && story.state.storyZh ? (
              <section className="mx-auto mb-6 max-w-2xl">
                <p className="text-sm font-semibold text-primary">Daily Story</p>
                <h1 className="mt-1 font-display text-3xl">
                  {story.state.title ?? deriveStableDailyStoryTitle(story.state.storyZh)}
                </h1>
              </section>
            ) : null}
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
            phase === "readingAloudTranscribing" ? (
              <Loading label={statusLabel(phase)} />
            ) : null}
            {showConversationDraft ? (
              <Conversation
                messages={story.state.messages}
                typed={typed}
                onTypedChange={setTyped}
                onSendTyped={() => void submitTyped()}
                canType={story.capabilities.chat && story.canEdit && phase === "chatting"}
                voiceEnabled={story.capabilities.asr}
                recording={
                  phase === "recording" ||
                  phase === "recordingDraftReady" ||
                  Boolean(conversationDraft)
                }
                recordingDraft={conversationDraft}
                pendingSegment={pendingSegment}
                draftError={draftError}
                draftSaving={draftSaving}
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
                onContinueRecording={() => continueDraftRecording(false)}
                onCompleteRecording={() => void completeDraft(false)}
                onDiscardRecording={() => void discardDraft(false)}
                onRetrySave={retryPendingSegment}
                onDiscardPending={discardPendingSegment}
                onCancelRecording={() => {
                  commands.cancelRecording();
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
                    onClick={() => commands.sendAsr(transcriptDraft)}
                    disabled={!story.canEdit || !transcriptDraft.trim()}
                  >
                    <Send className="size-4" aria-hidden />
                    发送此转写
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-full"
                    onClick={() => commands.saveAsrDraft(transcriptDraft)}
                    disabled={!story.canEdit || !transcriptDraft.trim()}
                  >
                    保存修改
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      commands.reRecord();
                      recorder.reset();
                    }}
                    disabled={!story.canEdit}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    重新录制
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  也可以重新录制，以补充或修正刚才的内容。
                </p>
              </section>
            ) : null}
            {phase === "review" || (phase === "reviewing" && story.state.review) ? (
              <ReviewTabs
                value={reviewTab}
                onValueChange={setReviewTab}
                messages={story.state.messages}
                conversationAudios={story.conversationAudios}
                conversationAudiosLoading={story.conversationAudiosLoading}
                conversationAudioUrls={conversationAudioUrls}
                reviewProps={reviewProps}
              />
            ) : null}
            {phase === "reviewing" && !story.state.review ? (
              <ReviewProgress onCancel={commands.cancel} />
            ) : null}
            {showReadAloudDraft && phase !== "review" ? (
              // Keep the operation panel mounted while read-aloud recording is active so
              // stopping or cancelling never depends on which review tab was last selected.
              <Review {...reviewProps} />
            ) : null}
            {phase === "error" ? (
              <section className="mx-auto max-w-xl rounded-3xl border border-destructive/30 bg-card p-6 text-center shadow-lift">
                <h1 className="font-display text-2xl">操作没有完成</h1>
                <p className="mt-3 text-sm text-muted-foreground">{story.state.error?.message}</p>
                {errorRetryUi.showCachedAudioRetry ? (
                  <>
                    {cachedAudioUrl ? (
                      <audio className="mt-5 w-full" controls src={cachedAudioUrl} />
                    ) : null}
                    <Button
                      className="mt-3 rounded-full"
                      onClick={commands.retryCachedAudio}
                      disabled={!story.canEdit}
                    >
                      重试
                    </Button>
                  </>
                ) : null}
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {errorPanelNeedsOwnDraftActions && activeDraft ? (
                    <DraftActions
                      draft={activeDraft}
                      saving={draftSaving}
                      pendingSegment={pendingSegment}
                      draftError={draftError}
                      onContinue={() => continueDraftRecording(activeDraft.purpose === "readAloud")}
                      onComplete={() => void completeDraft(activeDraft.purpose === "readAloud")}
                      onDiscard={() => void discardDraft(activeDraft.purpose === "readAloud")}
                      onRetrySave={retryPendingSegment}
                      onDiscardPending={discardPendingSegment}
                    />
                  ) : null}
                  {story.state.pendingTranscript?.source === "asr" ? (
                    <Button
                      className="rounded-full"
                      onClick={() => commands.saveAsrDraft(transcriptDraft)}
                      disabled={!story.canEdit || !transcriptDraft.trim()}
                    >
                      保存英文转写
                    </Button>
                  ) : null}
                  {errorRetryUi.showGenericRetry ? (
                    <Button
                      className="rounded-full"
                      onClick={commands.retry}
                      disabled={!story.canEdit}
                    >
                      重试
                    </Button>
                  ) : null}
                  {errorRetryUi.useDraftRetryEntry ? (
                    <p className="text-sm text-muted-foreground">
                      请使用上方录音草稿入口手动再次转写或重新提交。
                    </p>
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
