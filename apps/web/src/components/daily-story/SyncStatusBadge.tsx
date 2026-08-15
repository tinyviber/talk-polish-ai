import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getStorySyncStatus,
  subscribeStorySync,
  type StorySyncSnapshot,
} from "@/features/daily-story/sync/worker";

function label(snapshot: StorySyncSnapshot) {
  if (snapshot.status === "syncing") return "同步中";
  if (snapshot.status === "synced") return "已同步";
  if (snapshot.status === "pending") return "等待同步";
  if (snapshot.status === "offline") return "离线";
  if (snapshot.status === "error") return "同步异常";
  return "未启用同步";
}

export function SyncStatusBadge() {
  const [snapshot, setSnapshot] = useState<StorySyncSnapshot>(getStorySyncStatus());
  useEffect(() => {
    const unsubscribe = subscribeStorySync(setSnapshot);
    return () => {
      unsubscribe();
    };
  }, []);
  const Icon =
    snapshot.status === "syncing" ? Loader2 : snapshot.status === "offline" ? CloudOff : Cloud;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground"
      title={snapshot.message ?? undefined}
      aria-label={snapshot.message ?? label(snapshot)}
    >
      <Icon
        className={`size-3 ${snapshot.status === "syncing" ? "animate-spin" : ""}`}
        aria-hidden
      />
      {label(snapshot)}
    </span>
  );
}
