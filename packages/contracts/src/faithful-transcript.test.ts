import { describe, expect, test } from "bun:test";
import { validateFaithfulTranscript } from "./faithful-transcript";

const noChange = [{ category: "punctuation" as const }];

describe("faithful transcript guard", () => {
  test("keeps learner grammar, fillers, repetitions, and false starts", () => {
    const raw = "um I I go to school yesterday and uh I meet my friend";
    expect(
      validateFaithfulTranscript(raw, {
        normalizedText: "Um, I I go to school yesterday, and, uh, I meet my friend.",
        changes: noChange,
      }),
    ).not.toBeNull();
  });

  test("rejects grammar correction and native-like rewrite", () => {
    expect(
      validateFaithfulTranscript("I go there yesterday", {
        normalizedText: "I went there yesterday.",
        changes: [{ category: "homophone" }],
      }),
    ).toBeNull();
    expect(
      validateFaithfulTranscript("I I don't know", {
        normalizedText: "I am not sure.",
        changes: [{ category: "punctuation" }],
      }),
    ).toBeNull();
  });

  test("allows only high-confidence intent plus clear object context", () => {
    expect(
      validateFaithfulTranscript("I want to sea my friend", {
        normalizedText: "I want to see my friend.",
        changes: [{ category: "homophone", from: "sea", to: "see" }],
      }),
    ).toMatchObject({ normalizedText: "I want to see my friend." });
    for (const raw of [
      "I go to sea my friend",
      "I went to sea",
      "I sailed to sea",
      "I want to sea",
      "I want to sea the ocean",
    ]) {
      expect(
        validateFaithfulTranscript(raw, {
          normalizedText: raw.replace("sea", "see"),
          changes: [{ category: "homophone", from: "sea", to: "see" }],
        }),
      ).toBeNull();
    }
  });

  test("rejects token insertion, deletion, and reordering", () => {
    expect(
      validateFaithfulTranscript("I like this", {
        normalizedText: "I really like this.",
        changes: [{ category: "punctuation" }],
      }),
    ).toBeNull();
  });
});
