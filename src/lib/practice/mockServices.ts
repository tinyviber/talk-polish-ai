import type { Annotation, Attempt, Feedback, Prompt, Scores } from "./types";

/**
 * Deterministic mock AI / ASR / scoring layer.
 * Swap these functions for real endpoints without touching the UI.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Bank = {
  first: { transcript: string; annotations: Annotation[] };
  second: { transcript: string; annotations: Annotation[] };
  feedback: Feedback["improvements"];
  expressions: Feedback["expressions"];
  headline: [string, string];
};

const BANK: Record<string, Bank> = {
  "en-smalltalk": {
    first: {
      transcript:
        "Um, my weekend was... good, I think. I go to a park with my friend, and, uh, we eat some food there. It was, how to say, very relax. And, um, yeah. That's all.",
      annotations: [
        { text: "Um,", kind: "filler", note: "Long hesitation before starting" },
        { text: "my weekend was", kind: "ok" },
        { text: "good, I think.", kind: "ok" },
        { text: "I go to a park", kind: "grammar", note: "Past tense: “I went to a park”" },
        { text: "with my friend, and, uh,", kind: "filler", note: "Filler + pause (1.8s)" },
        { text: "we eat some food", kind: "grammar", note: "“we grabbed lunch” sounds natural" },
        { text: "there. It was,", kind: "ok" },
        { text: "how to say,", kind: "filler", note: "Try “kind of” or “sort of” instead" },
        { text: "very relax.", kind: "word", note: "“really relaxing”" },
        { text: "And, um, yeah. That's all.", kind: "filler", note: "Close by asking them back" },
      ],
    },
    second: {
      transcript:
        "It was pretty relaxing, actually. I went to the park with a friend on Saturday and we grabbed lunch outside. Nothing dramatic, but exactly what I needed. How about you — did you get up to anything?",
      annotations: [
        { text: "It was pretty relaxing, actually.", kind: "ok" },
        { text: "I went to the park", kind: "ok", note: "Past tense fixed" },
        { text: "with a friend on Saturday", kind: "ok" },
        { text: "and we grabbed lunch outside.", kind: "ok", note: "Natural collocation" },
        { text: "Nothing dramatic, but exactly what I needed.", kind: "ok" },
        {
          text: "How about you — did you get up to anything?",
          kind: "ok",
          note: "Great: you returned the question",
        },
      ],
    },
    feedback: [
      {
        title: "Use the past tense consistently",
        detail: "You told a past story with present-tense verbs, which makes the timeline unclear.",
        before: "I go to a park and we eat some food.",
        after: "I went to the park and we grabbed lunch.",
      },
      {
        title: "Replace “how to say” with a real filler",
        detail: "Native speakers stall with short phrases that still sound fluent.",
        before: "It was, how to say, very relax.",
        after: "It was, kind of, really relaxing.",
      },
      {
        title: "Hand the conversation back",
        detail: "Small talk works when you return the question within 30 seconds.",
        before: "And yeah. That's all.",
        after: "How about you — did you get up to anything?",
      },
    ],
    expressions: [
      {
        id: "ex-grab-lunch",
        lang: "en",
        text: "grab lunch",
        meaning: "casual way to say “eat lunch”",
      },
      {
        id: "ex-nothing-dramatic",
        lang: "en",
        text: "nothing dramatic",
        meaning: "a modest, low-key way to describe plans",
      },
      {
        id: "ex-get-up-to",
        lang: "en",
        text: "did you get up to anything?",
        meaning: "friendly way to ask about someone's plans",
      },
    ],
    headline: ["Clear ideas, but the tenses slip", "Much smoother — you sound like yourself"],
  },
  "ja-smalltalk": {
    first: {
      transcript:
        "えーと、週末は……友だちと、公園に行きます。それから、ごはんを食べました。とても、あの、楽しいでした。以上です。",
      annotations: [
        { text: "えーと、", kind: "filler", note: "出だしに2.1秒の間" },
        { text: "週末は……", kind: "ok" },
        { text: "友だちと、公園に行きます。", kind: "grammar", note: "過去形に:「行きました」" },
        { text: "それから、ごはんを食べました。", kind: "ok" },
        { text: "とても、あの、", kind: "filler", note: "「あの」の連続が目立ちます" },
        { text: "楽しいでした。", kind: "grammar", note: "「楽しかったです」が正しい形" },
        { text: "以上です。", kind: "word", note: "雑談では硬すぎます" },
      ],
    },
    second: {
      transcript:
        "週末は友だちと近くの公園に行きました。天気がよかったので、外でお昼を食べて、のんびりできました。すごく楽しかったです。〇〇さんはどうでしたか？",
      annotations: [
        { text: "週末は友だちと近くの公園に行きました。", kind: "ok", note: "過去形◎" },
        { text: "天気がよかったので、", kind: "ok", note: "理由をつなげられています" },
        { text: "外でお昼を食べて、のんびりできました。", kind: "ok", note: "自然な言い方" },
        { text: "すごく楽しかったです。", kind: "ok", note: "形容詞の過去形◎" },
        { text: "〇〇さんはどうでしたか？", kind: "ok", note: "相手に返せました" },
      ],
    },
    feedback: [
      {
        title: "い形容詞の過去形",
        detail: "「楽しいでした」は誤りです。い形容詞は「〜かったです」に変えます。",
        before: "とても楽しいでした。",
        after: "すごく楽しかったです。",
      },
      {
        title: "時制をそろえる",
        detail: "過去の話は最初から最後まで過去形で話すと伝わりやすくなります。",
        before: "公園に行きます。それから食べました。",
        after: "公園に行きました。それからお昼を食べました。",
      },
      {
        title: "「以上です」は会議用",
        detail: "雑談では相手に質問を返して会話を続けましょう。",
        before: "以上です。",
        after: "〇〇さんはどうでしたか？",
      },
    ],
    expressions: [
      {
        id: "ex-nonbiri",
        lang: "ja",
        text: "のんびりできました",
        reading: "のんびりできました",
        meaning: "I was able to take it easy / relax",
      },
      {
        id: "ex-tenki",
        lang: "ja",
        text: "天気がよかったので",
        reading: "てんきがよかったので",
        meaning: "because the weather was nice (giving a reason)",
      },
      {
        id: "ex-dou",
        lang: "ja",
        text: "〜さんはどうでしたか？",
        meaning: "How about you? (returning the question)",
      },
    ],
    headline: ["内容はいいので、あとは形だけ", "とても自然になりました"],
  },
};

const GENERIC_EN: Bank = {
  first: {
    transcript:
      "Uh, so, I think... the main reason is, we don't have enough time. And also the, um, the design is not finish yet. So I decide to move it. I think it is better like this, maybe.",
    annotations: [
      { text: "Uh, so, I think...", kind: "filler", note: "2.4s pause before the point" },
      { text: "the main reason is, we don't have enough time.", kind: "ok" },
      {
        text: "And also the, um, the design is not finish yet.",
        kind: "grammar",
        note: "“wasn't finished yet”",
      },
      { text: "So I decide to move it.", kind: "grammar", note: "Past tense: “I decided”" },
      {
        text: "I think it is better like this, maybe.",
        kind: "word",
        note: "Hedging twice weakens it",
      },
    ],
  },
  second: {
    transcript:
      "I pushed the launch back by a week for two reasons. First, the design wasn't finished, and shipping it half-done would have cost us more time later. Second, it gave QA a proper run-through. We launched on the new date with no rollbacks.",
    annotations: [
      {
        text: "I pushed the launch back by a week for two reasons.",
        kind: "ok",
        note: "Decision first — strong opening",
      },
      { text: "First, the design wasn't finished,", kind: "ok" },
      {
        text: "and shipping it half-done would have cost us more time later.",
        kind: "ok",
        note: "Nice conditional",
      },
      { text: "Second, it gave QA a proper run-through.", kind: "ok" },
      { text: "We launched on the new date with no rollbacks.", kind: "ok", note: "Clear outcome" },
    ],
  },
  feedback: [
    {
      title: "Lead with the decision",
      detail: "Start with what you did, then the reasons. It removes the long warm-up pause.",
      before: "Uh, so, I think... the main reason is...",
      after: "I pushed the launch back by a week for two reasons.",
    },
    {
      title: "Keep past events in past tense",
      detail: "“I decide” and “is not finish” break the timeline.",
      before: "The design is not finish, so I decide to move it.",
      after: "The design wasn't finished, so I decided to move it.",
    },
    {
      title: "Don't hedge twice",
      detail: "“I think… maybe” makes a reasonable decision sound uncertain.",
      before: "I think it is better like this, maybe.",
      after: "It was the right call.",
    },
  ],
  expressions: [
    {
      id: "ex-push-back",
      lang: "en",
      text: "push something back",
      meaning: "to delay to a later date",
    },
    {
      id: "ex-half-done",
      lang: "en",
      text: "ship it half-done",
      meaning: "release something before it's ready",
    },
    {
      id: "ex-right-call",
      lang: "en",
      text: "it was the right call",
      meaning: "confident way to stand by a decision",
    },
  ],
  headline: ["Good reasoning, buried under hesitation", "Direct, structured and confident"],
};

const GENERIC_JA: Bank = {
  first: {
    transcript:
      "えっと……すみません、ちょっと問題があります。私は予約しました、でも、ないと言いました。どうすればいいですか。困ります。",
    annotations: [
      { text: "えっと……すみません、", kind: "filler", note: "出だしに間があります" },
      { text: "ちょっと問題があります。", kind: "ok" },
      {
        text: "私は予約しました、でも、ないと言いました。",
        kind: "grammar",
        note: "主語が混ざっています",
      },
      { text: "どうすればいいですか。", kind: "ok" },
      { text: "困ります。", kind: "word", note: "「困っています」の方が自然" },
    ],
  },
  second: {
    transcript:
      "すみません、先月オンラインで予約しまして、確認メールも持っています。番号をお伝えしますので、もう一度お調べいただけますか。もし見つからない場合は、同じ条件のお部屋はありますでしょうか。",
    annotations: [
      { text: "すみません、先月オンラインで予約しまして、", kind: "ok", note: "状況説明が明確" },
      { text: "確認メールも持っています。", kind: "ok", note: "証拠を先に出せています" },
      {
        text: "番号をお伝えしますので、もう一度お調べいただけますか。",
        kind: "ok",
        note: "丁寧な依頼形◎",
      },
      { text: "同じ条件のお部屋はありますでしょうか。", kind: "ok", note: "次の選択肢を提案" },
    ],
  },
  feedback: [
    {
      title: "「〜ていただけますか」で依頼する",
      detail: "「どうすればいいですか」より、具体的にお願いする方が話が早く進みます。",
      before: "どうすればいいですか。",
      after: "もう一度お調べいただけますか。",
    },
    {
      title: "状況 → 事実 → お願いの順で",
      detail: "先に事実（予約した・メールがある）を出すと相手が動きやすくなります。",
      before: "予約しました、でも、ないと言いました。",
      after: "先月予約しまして、確認メールも持っています。",
    },
    {
      title: "感情は「〜ています」で",
      detail: "今の状態を表すときは進行形にします。",
      before: "困ります。",
      after: "困っています。",
    },
  ],
  expressions: [
    {
      id: "ex-shirabete",
      lang: "ja",
      text: "お調べいただけますか",
      reading: "おしらべいただけますか",
      meaning: "Could you check for me? (polite request)",
    },
    {
      id: "ex-kakunin",
      lang: "ja",
      text: "確認メール",
      reading: "かくにんメール",
      meaning: "confirmation email",
    },
    {
      id: "ex-onaji",
      lang: "ja",
      text: "同じ条件のお部屋",
      reading: "おなじじょうけんのおへや",
      meaning: "a room with the same conditions",
    },
  ],
  headline: ["言いたいことは伝わっています", "落ち着いた、頼れる話し方に"],
};

function bankFor(prompt: Prompt): Bank {
  return BANK[prompt.id] ?? (prompt.lang === "ja" ? GENERIC_JA : GENERIC_EN);
}

const FIRST_SCORES: Scores = {
  fluency: 58,
  pauses: 51,
  grammar: 62,
  vocabulary: 66,
  naturalness: 55,
  pronunciation: 71,
};

const SECOND_SCORES: Scores = {
  fluency: 79,
  pauses: 74,
  grammar: 88,
  vocabulary: 81,
  naturalness: 84,
  pronunciation: 78,
};

const avg = (s: Scores) =>
  Math.round(Object.values(s).reduce((a, b) => a + b, 0) / Object.keys(s).length);

/** Mock ASR + AI feedback. Deterministic per prompt + attempt. */
export async function analyzeAttempt(
  prompt: Prompt,
  index: 1 | 2,
  durationSec: number,
  mocked: boolean,
): Promise<Attempt> {
  await wait(1400);
  const bank = bankFor(prompt);
  const part = index === 1 ? bank.first : bank.second;
  const scores = index === 1 ? FIRST_SCORES : SECOND_SCORES;
  const feedback: Feedback = {
    overall: avg(scores),
    headline: bank.headline[index - 1] ?? "",
    scores,
    improvements: index === 1 ? bank.feedback : bank.feedback.slice(0, 1),
    annotations: part.annotations,
    expressions: bank.expressions,
    stats:
      index === 1
        ? { words: 38, wpm: 71, fillers: 6, longestPause: "2.4s" }
        : { words: 52, wpm: 118, fillers: 1, longestPause: "0.7s" },
  };
  return { index, transcript: part.transcript, feedback, durationSec, mocked };
}

/** Mock TTS — returns a short beep-free silent duration for a believable player. */
export async function synthesizeModelAnswer(
  text: string,
): Promise<{ seconds: number; text: string }> {
  await wait(600);
  return { seconds: Math.max(4, Math.round(text.length / 14)), text };
}
