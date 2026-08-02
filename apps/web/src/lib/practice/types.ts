import type {
  Annotation,
  Attempt as ContractAttempt,
  Expression,
  Feedback,
  Improvement,
  Lang,
  Prompt,
  Progress,
  Scores,
  SessionRecord,
} from "@kotoba/contracts";

export type {
  Annotation,
  Expression,
  Feedback,
  Improvement,
  Lang,
  Prompt,
  Progress,
  Scores,
  SessionRecord,
};

export type ScoreKey = keyof Scores;

/** UI only consumes completed attempts; the API contract remains nullable while processing. */
export type Attempt = Pick<ContractAttempt, "index" | "durationSec" | "mocked"> & {
  transcript: string;
  feedback: Feedback;
};

export type ProgressState = {
  sessions: SessionRecord[];
  saved: Expression[];
  lang: Lang | null;
  onboarded: boolean;
};
