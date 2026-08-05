import type { Lang, Prompt } from "./types";

export type FrozenPracticeContext = {
  clientSessionId: string;
  sessionId: string | null;
  promptId: string;
  lang: Lang;
};

export type RecoverableWorkflowIdentity = Pick<
  FrozenPracticeContext,
  "clientSessionId" | "sessionId" | "promptId" | "lang"
>;

/** Copy the immutable session identity before any feedback or retry UI runs. */
export function hydratePracticeWorkflow(
  workflow: RecoverableWorkflowIdentity,
): FrozenPracticeContext {
  return {
    clientSessionId: workflow.clientSessionId,
    sessionId: workflow.sessionId,
    promptId: workflow.promptId,
    lang: workflow.lang,
  };
}

export function selectFrozenPrompt(
  prompts: Prompt[],
  context: FrozenPracticeContext | null,
  fallback: Prompt | null,
) {
  return context
    ? (prompts.find((candidate) => candidate.id === context.promptId) ?? null)
    : fallback;
}

export function queueIdentityForAttempt(context: FrozenPracticeContext, attemptIndex: 1 | 2) {
  return {
    clientSessionId: context.clientSessionId,
    promptId: context.promptId,
    lang: context.lang,
    attemptIndex,
  };
}
