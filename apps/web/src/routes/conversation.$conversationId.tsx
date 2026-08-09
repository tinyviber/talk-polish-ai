import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DailyStoryPage } from "@/components/daily-story/DailyStoryPage";

export const Route = createFileRoute("/conversation/$conversationId")({
  head: () => ({
    meta: [
      { title: "每日故事对话 — Kotoba Loop" },
      { name: "description", content: "继续一段独立保存的 Daily Story 对话。" },
    ],
  }),
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: ConversationRoute,
});

function ConversationRoute() {
  const { conversationId } = Route.useParams();
  const { new: isNew } = Route.useSearch();
  return (
    <DailyStoryPage
      key={conversationId}
      conversationId={conversationId}
      isNew={isNew === true}
    />
  );
}
