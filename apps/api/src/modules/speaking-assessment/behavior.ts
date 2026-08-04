import type { Lang } from "@kotoba/contracts";

export function speakingBehavior(lang: Lang) {
  return lang === "ja"
    ? "Japanese behavior: respect natural politeness, particles, tense, and conversational turn-taking."
    : "English behavior: prioritize tense, collocation, discourse markers, and returning the question naturally.";
}

export function attemptBehavior(attemptIndex: 1 | 2) {
  return attemptIndex === 1
    ? "First attempt: identify the smallest high-impact improvements."
    : "Second attempt: compare against the first attempt and reward concrete improvement.";
}
