export type AttemptReadyEvent = {
  type: "AttemptReady";
  attemptId: string;
  learnerId: string;
  sessionId: string;
  attemptIndex: 1 | 2;
  overallScore: number;
};
