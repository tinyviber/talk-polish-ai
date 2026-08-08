import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/daily-story/SettingsPage";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "API 设置 — 每日故事对话" },
      { name: "description", content: "管理当前浏览器上的 Daily Story API 配置。" },
    ],
  }),
  component: SettingsPage,
});
