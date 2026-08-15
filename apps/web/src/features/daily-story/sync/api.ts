import {
  dailyStorySyncConflictResponseSchema,
  dailyStorySyncListResponseSchema,
  dailyStorySyncPushResponseSchema,
  type DailyStorySyncConversation,
  type DailyStorySyncRemoteObject,
} from "@kotoba/contracts";
import { apiUrl } from "@/lib/practice/api";

// The existing IndexedDB lease is 15s. Keep one request below that bound;
// the worker also renews the lease while a run is active.
const SYNC_REQUEST_TIMEOUT_MS = 10_000;

export class StorySyncApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remoteObject: DailyStorySyncRemoteObject | null;

  constructor(
    message: string,
    status: number,
    code = "sync_error",
    remoteObject: DailyStorySyncRemoteObject | null = null,
  ) {
    super(message);
    this.name = "StorySyncApiError";
    this.status = status;
    this.code = code;
    this.remoteObject = remoteObject;
  }
}

async function syncFetch(token: string, path: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(apiUrl(path), {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 409) {
      const conflict = dailyStorySyncConflictResponseSchema.safeParse(payload);
      throw new StorySyncApiError(
        "远端对话已变化，正在保留两个版本。",
        409,
        "conflict",
        conflict.success ? conflict.data.current : null,
      );
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String(
              (payload as { error?: { message?: unknown } }).error?.message ?? "同步请求失败。",
            )
          : "同步请求失败。";
      throw new StorySyncApiError(
        message,
        response.status,
        response.status === 401 ? "unauthorized" : "sync_error",
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof StorySyncApiError) throw error;
    throw new StorySyncApiError(
      controller.signal.aborted ? "同步请求超时。" : "无法连接同步服务。",
      0,
      controller.signal.aborted ? "timeout" : "network_error",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function pullSyncObjects(token: string): Promise<DailyStorySyncRemoteObject[]> {
  const objects: DailyStorySyncRemoteObject[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const payload = dailyStorySyncListResponseSchema.parse(
      await syncFetch(token, `/api/sync/conversations${query}`),
    );
    objects.push(...payload.objects);
    cursor = payload.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new StorySyncApiError("同步游标未向前推进。", 422, "invalid_sync_cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return objects;
}

export async function pushSyncObject(input: {
  token: string;
  conversationId: string;
  mutationId: string;
  expectedRemoteRevision: number | null;
  conversation: DailyStorySyncConversation | null;
}) {
  const payload = dailyStorySyncPushResponseSchema.parse(
    await syncFetch(
      input.token,
      `/api/sync/conversations/${encodeURIComponent(input.conversationId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          mutationId: input.mutationId,
          expectedRemoteRevision: input.expectedRemoteRevision,
          clientRevision: input.conversation?.revision ?? 0,
          ...(input.conversation?.sessionInstanceId
            ? { sessionInstanceId: input.conversation.sessionInstanceId }
            : {}),
          object: input.conversation,
        }),
      },
    ),
  );
  return payload.object;
}
