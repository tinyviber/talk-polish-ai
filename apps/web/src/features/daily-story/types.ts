import type {
  DailyStoryReviewEvidence,
  DailyStoryReviewRubric,
  DailyStoryReviewRubricItem,
  ProviderPresetId,
} from "@kotoba/contracts";

export type DailyCapability = "chat" | "asr" | "tts";

export type ChatProvider = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional identity; omitted by legacy browser settings. */
  preset?: ProviderPresetId;
};

export type AsrProvider = ChatProvider & {
  responseFormat?: string;
};

export type DailyStoryLocalSettings = {
  asrDirect?: boolean;
};

export type TtsProvider = ChatProvider & {
  voice: string;
};

export type ProviderSettings = {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  chat?: ChatProvider;
  asr?: AsrProvider;
  local?: DailyStoryLocalSettings;
  tts?: TtsProvider;
};

export type TurnSource = "asr" | "typed";

export type DailyMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  source?: TurnSource;
};

export type ReviewSuggestion = {
  sourceTurnId: string;
  original: string;
  improved: string;
  category: "clarity" | "grammar" | "naturalness";
  explanationZh: string;
};

export type ReviewEvidence = DailyStoryReviewEvidence;
export type ReviewRubricItem = DailyStoryReviewRubricItem;
export type ReviewRubric = DailyStoryReviewRubric;

export type DailyReview = {
  score: number | null;
  comment: string | null;
  rubric: ReviewRubric | null;
  suggestions: ReviewSuggestion[];
};

/** Stable only. Never contains config, Blob, operation or error. */
export type StorySession = {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  phase: "chatting" | "transcriptReady" | "review";
  storyZh: string;
  messages: DailyMessage[];
  pendingAsrTranscript?: { id: string; text: string };
  review?: DailyReview;
};

export type StorySessionReviewSnapshot = {
  suggestions: ReviewSuggestion[];
};

export type StorySessionSnapshot = Omit<
  StorySession,
  "schemaVersion" | "revision" | "updatedAt" | "review"
> & { review?: DailyReview | StorySessionReviewSnapshot };

export type StorySessionSummary = Pick<
  StorySession,
  "revision" | "updatedAt" | "phase" | "storyZh"
> & { id: string; review: DailyReview | null };

export type ConnectionState = "idle" | "checking" | "connected" | "failed";

export function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function createConversationId() {
  return createId("conversation");
}

export function trimBounded(value: string, max: number) {
  return value.trim().slice(0, max);
}
