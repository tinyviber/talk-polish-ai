import { createFileRoute } from "@tanstack/react-router";
import { DailyStoryPage } from "@/components/daily-story/DailyStoryPage";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "每日故事对话 — Kotoba Loop" },
      { name: "description", content: "用你的真实故事，进行一段简单自然的英语对话。" },
      { property: "og:title", content: "每日故事对话 — Kotoba Loop" },
      { property: "og:description", content: "从真实故事开始，练习自然英语表达。" },
    ],
  }),
  component: DailyStoryPage,
});
