import { z } from "zod";
import { authenticatedApiFetch, ApiClientError } from "@/lib/practice/api";
import { normalizeRecordedAudio } from "@/lib/practice/audio-format";
import { apiBaseUrl } from "@/lib/practice/mode";
import type {
  AsrProvider,
  ChatProvider,
  DailyCapability,
  DailyMessage,
  DailyReview,
  ProviderSettings,
  TtsProvider,
  TurnSource,
} from "./types";

const openingSchema = z.object({
  opening: z.object({ id: z.string(), role: z.literal("assistant"), text: z.string().min(1) }),
});
const replySchema = z.object({
  understanding: z.enum(["understood", "clarify", "retry"]),
  reply: z.string().min(1),
});
const transcriptSchema = z.object({ transcript: z.string() });
const reviewSchema = z.object({
  suggestions: z
    .array(
      z.object({
        sourceTurnId: z.string(),
        original: z.string(),
        improved: z.string(),
        category: z.enum(["clarity", "grammar", "naturalness"]),
        explanationZh: z.string(),
      }),
    )
    .max(3),
});
const checkSchema = z.object({
  capability: z.enum(["chat", "asr", "tts"]),
  status: z.literal("connected"),
});

export class DailyApiError extends Error {
  readonly status: number;

  constructor(status: number, message = dailyErrorMessage(status)) {
    super(message);
    this.name = "DailyApiError";
    this.status = status;
  }
}

function dailyErrorMessage(status: number) {
  if (status === 401 || status === 403) return "配置验证失败。请检查对应服务的 API Key。";
  if (status === 429) return "请求过于频繁。请稍后重试。";
  if (status === 408 || status === 504) return "服务响应超时。请重试。";
  if (status >= 400 && status < 500) return "请求无法完成。请检查配置或缩短内容后重试。";
  if (status >= 500) return "服务暂时不可用。请稍后重试。";
  return "无法连接服务。请检查网络后重试。";
}

function assertDailySameOrigin() {
  if (typeof window === "undefined") return;
  if (!apiBaseUrl) return;
  let configured: URL;
  try {
    configured = new URL(apiBaseUrl, window.location.origin);
  } catch {
    throw new DailyApiError(0, "Daily Story 仅允许使用同源 API。请移除跨域 VITE_API_URL 配置。");
  }
  if (configured.origin !== window.location.origin) {
    throw new DailyApiError(0, "Daily Story 仅允许使用同源 API。请移除跨域 VITE_API_URL 配置。");
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body: BodyInit,
  signal?: AbortSignal,
): Promise<T> {
  assertDailySameOrigin();
  let response: Response;
  try {
    response = await authenticatedApiFetch(path, {
      method: "POST",
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof ApiClientError) throw new DailyApiError(error.status);
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DailyApiError(0);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const backendMessage =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : undefined;
    if (
      response.status === 422 &&
      backendMessage &&
      backendMessage !== "Request validation failed."
    ) {
      throw new DailyApiError(response.status, backendMessage);
    }
    throw new DailyApiError(response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new DailyApiError(response.status, "服务返回格式不兼容。请检查配置后重试。");
  return parsed.data;
}

function json(value: unknown) {
  return JSON.stringify(value);
}

export async function startDailyStory(input: {
  storyZh: string;
  chat: ChatProvider;
  signal?: AbortSignal;
}) {
  return request(
    "/api/daily-story/start",
    openingSchema,
    json({ storyZh: input.storyZh, chat: input.chat }),
    input.signal,
  );
}

export async function transcribeDailyStory(input: {
  audio: Blob;
  asr: AsrProvider;
  signal?: AbortSignal;
}) {
  // Normalize cached WebM recordings too. Some compatible gateways reject
  // WebM while accepting the equivalent PCM WAV payload.
  const normalized = await normalizeRecordedAudio(input.audio);
  const form = new FormData();
  form.set("audio", normalized.blob, `recording.${extension(normalized.mimeType)}`);
  form.set("asr", json(input.asr));
  return request("/api/daily-story/transcribe", transcriptSchema, form, input.signal);
}

export async function replyDailyStory(input: {
  storyZh: string;
  history: DailyMessage[];
  turn: { id: string; source: TurnSource; text: string };
  chat: ChatProvider;
  signal?: AbortSignal;
}) {
  return request(
    "/api/daily-story/reply",
    replySchema,
    json({ storyZh: input.storyZh, history: input.history, turn: input.turn, chat: input.chat }),
    input.signal,
  );
}

export async function reviewDailyStory(input: {
  storyZh: string;
  history: DailyMessage[];
  chat: ChatProvider;
  signal?: AbortSignal;
}): Promise<DailyReview> {
  const { signal, ...body } = input;
  return request("/api/daily-story/review", reviewSchema, json(body), signal);
}

export async function checkDailyProvider(input: {
  capability: DailyCapability;
  provider: NonNullable<ProviderSettings[DailyCapability]>;
  signal?: AbortSignal;
}) {
  return request(
    "/api/daily-story/provider-check",
    checkSchema,
    json({ capability: input.capability, provider: input.provider }),
    input.signal,
  );
}

export async function synthesizeDailyStory(input: {
  text: string;
  tts: TtsProvider;
  signal?: AbortSignal;
}) {
  assertDailySameOrigin();
  let response: Response;
  try {
    response = await authenticatedApiFetch("/api/daily-story/tts", {
      method: "POST",
      body: json({ text: input.text, tts: input.tts }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof ApiClientError) throw new DailyApiError(error.status);
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DailyApiError(0);
  }
  if (!response.ok) throw new DailyApiError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/")) {
    throw new DailyApiError(response.status, "语音服务返回格式不兼容。请检查配置后重试。");
  }
  return response.blob();
}

function extension(mimeType: string) {
  const mime = mimeType.split(";")[0]?.toLowerCase();
  if (mime === "audio/mp4" || mime === "audio/m4a") return "m4a";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/mpeg") return "mp3";
  return "webm";
}
