import type { Lang, Prompt } from "./types";

export const PROMPTS: Prompt[] = [
  {
    id: "en-smalltalk",
    lang: "en",
    scenario: "Small talk",
    situation: "A colleague you barely know sits down next to you in the office kitchen.",
    question: "So, how was your weekend? Did you do anything fun?",
    hints: ["Mention one concrete thing", "Ask them back", "Keep it under a minute"],
    seconds: 45,
  },
  {
    id: "en-decision",
    lang: "en",
    scenario: "Explaining a decision",
    situation: "Your manager asks about a choice you made on a small project.",
    question: "Why did you decide to push the launch back by a week?",
    hints: ["State the decision first", "Give two reasons", "End with the outcome"],
    seconds: 60,
  },
  {
    id: "en-travel",
    lang: "en",
    scenario: "Handling a travel problem",
    situation: "You are at an airport counter. Your connecting flight was cancelled.",
    question: "I'm sorry, that flight is cancelled. What would you like to do?",
    hints: ["Explain your situation", "Ask for options", "Be polite but firm"],
    seconds: 60,
  },
  {
    id: "en-opinion",
    lang: "en",
    scenario: "Sharing an opinion",
    situation: "A friend asks what you think about working from home.",
    question: "Do you think remote work is better than going to an office?",
    hints: ["Take a clear position", "One example", "Acknowledge the other side"],
    seconds: 60,
  },
  {
    id: "ja-smalltalk",
    lang: "ja",
    scenario: "雑談 · Small talk",
    situation: "同僚と給湯室で会いました。月曜日の朝です。",
    question: "週末は何をしていましたか？",
    questionTranslation: "What did you do over the weekend?",
    hints: ["具体的なことを一つ", "相手にも質問する", "ですます調で"],
    seconds: 45,
  },
  {
    id: "ja-decision",
    lang: "ja",
    scenario: "決めた理由を説明する",
    situation: "上司に、予定を変更した理由を聞かれました。",
    question: "どうして発表を来週に変えたんですか？",
    questionTranslation: "Why did you move the presentation to next week?",
    hints: ["結論を先に", "理由を二つ", "「〜からです」を使う"],
    seconds: 60,
  },
  {
    id: "ja-travel",
    lang: "ja",
    scenario: "旅行のトラブル",
    situation: "ホテルのフロントです。予約が見つからないと言われました。",
    question: "申し訳ありません、ご予約が確認できないのですが……",
    questionTranslation: "I'm sorry, we can't find your reservation...",
    hints: ["状況を説明する", "確認をお願いする", "丁寧な表現で"],
    seconds: 60,
  },
  {
    id: "ja-opinion",
    lang: "ja",
    scenario: "意見を言う",
    situation: "友だちにリモートワークについて聞かれました。",
    question: "在宅勤務とオフィス勤務、どちらがいいと思いますか？",
    questionTranslation: "Which do you think is better, remote work or the office?",
    hints: ["立場をはっきりさせる", "例を一つ", "「〜と思います」で締める"],
    seconds: 60,
  },
];

export function promptsFor(lang: Lang) {
  return PROMPTS.filter((p) => p.lang === lang);
}

export function getPrompt(id: string) {
  return PROMPTS.find((p) => p.id === id) ?? PROMPTS[0];
}

export const LANG_LABEL: Record<Lang, string> = { en: "English", ja: "日本語 Japanese" };
