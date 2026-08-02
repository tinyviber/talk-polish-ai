export type Lang = "en" | "ja";

export type Prompt = {
  id: string;
  lang: Lang;
  scenario: string;
  situation: string;
  question: string;
  questionTranslation?: string;
  hints: string[];
  seconds: number;
};

export type ScoreKey =
  "fluency" | "pauses" | "grammar" | "vocabulary" | "naturalness" | "pronunciation";

export type Scores = Record<ScoreKey, number>;

export type Annotation = {
  text: string;
  kind: "ok" | "grammar" | "filler" | "word";
  note?: string;
};

export type Improvement = {
  title: string;
  detail: string;
  before: string;
  after: string;
};

export type Expression = {
  id: string;
  lang: Lang;
  text: string;
  reading?: string;
  meaning: string;
  savedAt?: number;
};

export type Feedback = {
  overall: number;
  headline: string;
  scores: Scores;
  improvements: Improvement[];
  annotations: Annotation[];
  expressions: Expression[];
  stats: { words: number; wpm: number; fillers: number; longestPause: string };
};

export type Attempt = {
  index: 1 | 2;
  transcript: string;
  feedback: Feedback;
  durationSec: number;
  mocked: boolean;
};

export type SessionRecord = {
  id: string;
  lang: Lang;
  promptId: string;
  date: string; // YYYY-MM-DD
  first: number;
  second: number | null;
};

export type ProgressState = {
  sessions: SessionRecord[];
  saved: Expression[];
  lang: Lang | null;
  onboarded: boolean;
};
