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

/** UI view of completed attempts, retaining server identity for recovery/playback. */
export type Attempt = Pick<ContractAttempt, "index" | "durationSec" | "mocked"> & {
  id?: string;
  clientAttemptId?: string;
  sessionId?: string;
  status?: ContractAttempt["status"];
  audio?: ContractAttempt["audio"];
  transcript: string;
  feedback: Feedback;
};

export type ProgressState = {
  sessions: SessionRecord[];
  saved: Expression[];
  lang: Lang | null;
  onboarded: boolean;
};
