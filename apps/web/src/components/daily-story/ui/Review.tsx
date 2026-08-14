import { useEffect, useId, useState } from "react";
import { Loader2, Mic, RotateCcw, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DailyStoryCachedAudio } from "@/features/daily-story/shared-types";
import type { DailyApiErrorDetails } from "@/features/daily-story/daily-api-errors";
import { formatDailyReviewErrorDetails } from "@/features/daily-story/review-error-details";
import type { DailyReview, ReviewRubric, ReviewSuggestion } from "@/features/daily-story/types";
import { reviewOriginalDiffSegments } from "@/features/daily-story/review-diff";
import type { RecordingDraft } from "@/features/daily-story/recording-drafts";
import type { RecorderDraft } from "@/lib/practice/useRecorder";
import { DraftActions, MessageList, MicProblem } from "./Conversation";

const REVIEW_RETRY_LABEL = "再说一次";

export type ReviewProps = {
  review: DailyReview | null;
  suggestions: ReviewSuggestion[];
  reviewBusy: boolean;
  reviewError: string | null;
  reviewErrorDetails?: DailyApiErrorDetails;
  onReReview: () => void;
  onCancelReview: () => void;
  onRetryReview: () => void;
  ttsEnabled: boolean;
  asrEnabled: boolean;
  readAloudRecording: boolean;
  recordingDraft: RecordingDraft | null;
  pendingSegment: RecorderDraft | null;
  draftError: string | null;
  draftSaving: boolean;
  recorderStatus: string;
  recorderError: string | null;
  readAloudTranscript: string | null;
  readAloudTarget: string | null;
  onPlay: (text: string) => void;
  onReadAloud: (target: string) => void;
  onStop: () => void;
  onContinueRecording: () => void;
  onCompleteRecording: () => void;
  onDiscardRecording: () => void;
  onRetrySave: () => void;
  onDiscardPending: () => void;
  onCancel: () => void;
  onNewStory: () => void;
  canEdit: boolean;
};

export function ReviewTabs({
  value,
  onValueChange,
  messages,
  conversationAudios,
  conversationAudiosLoading,
  conversationAudioUrls,
  reviewProps,
}: {
  value: "conversation" | "suggestions" | "score";
  onValueChange: (value: "conversation" | "suggestions" | "score") => void;
  messages: { id: string; role: "assistant" | "user"; text: string }[];
  conversationAudios: DailyStoryCachedAudio[];
  conversationAudiosLoading: boolean;
  conversationAudioUrls: Record<string, string>;
  reviewProps: ReviewProps;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) =>
        onValueChange(nextValue as "conversation" | "suggestions" | "score")
      }
      className="mx-auto max-w-2xl"
    >
      <TabsList className="grid h-auto w-full grid-cols-3 rounded-2xl p-1">
        <TabsTrigger value="conversation" className="rounded-xl py-2.5">
          原始对话
        </TabsTrigger>
        <TabsTrigger value="suggestions" className="rounded-xl py-2.5">
          修改建议
        </TabsTrigger>
        <TabsTrigger value="score" className="rounded-xl py-2.5">
          水平评分
        </TabsTrigger>
      </TabsList>
      <TabsContent value="conversation">
        <OriginalConversation
          messages={messages}
          audios={conversationAudios}
          audiosLoading={conversationAudiosLoading}
          audioUrls={conversationAudioUrls}
          reviewProps={reviewProps}
        />
      </TabsContent>
      <TabsContent value="suggestions">
        <Review {...reviewProps} />
      </TabsContent>
      <TabsContent value="score">
        <ScoreReview {...reviewProps} />
      </TabsContent>
    </Tabs>
  );
}

function OriginalConversation({
  messages,
  audios,
  audiosLoading,
  audioUrls,
  reviewProps,
}: {
  messages: { id: string; role: "assistant" | "user"; text: string }[];
  audios: DailyStoryCachedAudio[];
  audiosLoading: boolean;
  audioUrls: Record<string, string>;
  reviewProps: ReviewProps;
}) {
  return (
    <section className="mx-auto max-w-2xl">
      <p className="text-sm font-semibold text-primary">原始对话</p>
      <h1 className="mt-2 font-display text-3xl">这次聊了什么</h1>
      <div className="mt-6 space-y-3" aria-live="polite">
        <MessageList messages={messages} />
      </div>
      <section className="mt-6 rounded-3xl border border-border bg-card p-5 shadow-lift">
        <h2 className="font-medium">本地录音</h2>
        {audiosLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">正在加载本地录音…</p>
        ) : audios.length ? (
          <div className="mt-4 space-y-4">
            {audios.map((audio, index) => {
              const url = audioUrls[audio.clientAttemptId];
              return (
                <div key={audio.clientAttemptId}>
                  <p className="mb-2 text-sm text-muted-foreground">录音 {index + 1}</p>
                  {url ? (
                    <audio
                      className="w-full"
                      controls
                      preload="metadata"
                      src={url}
                      aria-label={`原始对话录音 ${index + 1}`}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">暂无本地录音。</p>
        )}
      </section>
      <ReviewActionBar {...reviewProps} />
    </section>
  );
}

export function Review({
  review,
  suggestions,
  reviewBusy,
  reviewError,
  reviewErrorDetails,
  onReReview,
  onCancelReview,
  onRetryReview,
  ttsEnabled,
  asrEnabled,
  readAloudRecording,
  recordingDraft,
  pendingSegment,
  draftError,
  draftSaving,
  recorderStatus,
  recorderError,
  readAloudTranscript,
  readAloudTarget,
  onPlay,
  onReadAloud,
  onStop,
  onContinueRecording,
  onCompleteRecording,
  onDiscardRecording,
  onRetrySave,
  onDiscardPending,
  onCancel,
  onNewStory,
  canEdit,
}: ReviewProps) {
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
          suggestions.map((item, index) => (
            <article
              key={`${item.sourceTurnId}:${item.original}:${item.improved}:${index}`}
              className="rounded-3xl border border-border bg-card p-5 shadow-lift"
            >
              <p className="text-sm text-muted-foreground">
                <span className="sr-only">原句，需要修改的部分已标记：</span>
                {reviewOriginalDiffSegments(item).map((segment) =>
                  segment.deleted ? (
                    <del key={segment.key} aria-label={`需修改：${segment.text}`}>
                      {segment.text}
                    </del>
                  ) : (
                    <span key={segment.key}>{segment.text}</span>
                  ),
                )}
              </p>
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
                停止录音
              </Button>
            ) : recorderStatus === "requesting" ? (
              <p className="mt-4 text-sm text-muted-foreground">正在打开麦克风…</p>
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
      <ReviewActionBar
        review={review}
        reviewBusy={reviewBusy}
        reviewError={reviewError}
        reviewErrorDetails={reviewErrorDetails}
        onReReview={onReReview}
        onCancelReview={onCancelReview}
        onRetryReview={onRetryReview}
        canEdit={canEdit && !readAloudRecording}
      />
      <Button className="mt-6 rounded-full shadow-tactile" onClick={onNewStory}>
        开始新故事
      </Button>
    </section>
  );
}

type ReviewActionProps = Pick<
  ReviewProps,
  | "review"
  | "reviewBusy"
  | "reviewError"
  | "reviewErrorDetails"
  | "onReReview"
  | "onCancelReview"
  | "onRetryReview"
> & { canEdit: boolean };

function ReviewActionBar({
  reviewBusy,
  reviewError,
  reviewErrorDetails,
  onReReview,
  onCancelReview,
  onRetryReview,
  canEdit,
}: ReviewActionProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailLines = formatDailyReviewErrorDetails(reviewErrorDetails);

  useEffect(() => {
    setDetailsOpen(false);
  }, [reviewError, reviewErrorDetails]);

  return (
    <div className="mt-6 rounded-3xl border border-border bg-card p-5 text-center shadow-lift">
      {reviewError ? (
        <div role="alert" className="text-sm text-destructive">
          <p>{reviewError}</p>
          {detailLines.length ? (
            <div className="mt-3 text-left">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-destructive"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                {detailsOpen ? "隐藏详情" : "显示详情"}
              </Button>
              {detailsOpen ? (
                <ul id={detailsId} className="mt-2 list-disc space-y-1 pl-5 text-xs break-words">
                  {detailLines.map((detail, index) => (
                    <li key={`${detail}:${index}`}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {reviewBusy ? (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            正在重新复盘…
          </span>
          <Button variant="outline" className="rounded-full" onClick={onCancelReview}>
            取消
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          className="rounded-full"
          onClick={reviewError ? onRetryReview : onReReview}
          disabled={!canEdit}
        >
          <RotateCcw className="size-4" aria-hidden />
          {reviewError ? "重试复盘" : "重新复盘"}
        </Button>
      )}
    </div>
  );
}

function ScoreReview({
  review,
  reviewBusy,
  reviewError,
  reviewErrorDetails,
  onReReview,
  onCancelReview,
  onRetryReview,
  canEdit,
}: ReviewProps) {
  const score = review?.score ?? null;
  const rubric = review?.rubric ?? null;
  const hasScore = score !== null;
  const hasRubric = rubric !== null;
  const hasOverallFeedback = Boolean(review?.overallFeedback);

  return (
    <section className="mx-auto max-w-2xl">
      <p className="text-sm font-semibold text-primary">水平评分</p>
      <h1 className="mt-2 font-display text-3xl">这次表达的整体表现</h1>
      {hasOverallFeedback ? (
        <div className="mt-6 rounded-3xl border border-border bg-card p-5 shadow-lift">
          <p className="text-sm font-semibold text-primary">整体评价</p>
          <p className="mt-2 text-sm leading-7">{review?.overallFeedback}</p>
        </div>
      ) : null}
      {hasScore ? (
        <div className="mt-6 rounded-3xl border border-border bg-card p-6 text-center shadow-lift">
          <p className="text-sm text-muted-foreground">总分</p>
          <p className="mt-1 font-display text-6xl leading-none text-primary">
            {score}
            <span className="text-2xl text-muted-foreground">/100</span>
          </p>
          {review?.comment ? <p className="mt-4 text-sm leading-7">{review.comment}</p> : null}
        </div>
      ) : null}
      {hasRubric ? (
        <div className="mt-4 space-y-3">
          <RubricCard label="流利度" item={rubric.fluency} />
          <RubricCard label="语法" item={rubric.grammar} />
          <RubricCard label="词汇" item={rubric.vocabulary} />
          <RubricCard label="自然度" item={rubric.naturalness} />
        </div>
      ) : null}
      {!hasScore && !hasRubric && !hasOverallFeedback ? (
        <div className="mt-6 rounded-3xl border border-dashed border-border bg-card p-6 text-center shadow-lift">
          <p className="font-medium">暂无评分/评论</p>
          <p className="mt-2 text-sm text-muted-foreground">点击重新复盘后生成。</p>
        </div>
      ) : null}
      <ReviewActionBar
        review={review}
        reviewBusy={reviewBusy}
        reviewError={reviewError}
        reviewErrorDetails={reviewErrorDetails}
        onReReview={onReReview}
        onCancelReview={onCancelReview}
        onRetryReview={onRetryReview}
        canEdit={canEdit}
      />
    </section>
  );
}

function RubricCard({ label, item }: { label: string; item: ReviewRubric["fluency"] }) {
  return (
    <article className="rounded-3xl border border-border bg-card p-5 shadow-lift">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">{label}</h2>
        <p className="font-display text-2xl text-primary">{item.score}/100</p>
      </div>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.comment}</p>
      {item.evidence.length ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold text-primary">对话依据</p>
          {item.evidence.map((evidence) => (
            <blockquote
              key={`${evidence.sourceTurnId}:${evidence.quote}`}
              className="rounded-2xl bg-secondary/70 px-3 py-2 text-sm"
            >
              “{evidence.quote}”
            </blockquote>
          ))}
        </div>
      ) : null}
    </article>
  );
}
