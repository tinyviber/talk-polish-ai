import { z } from "zod";
import {
  faithfulTranscriptChangeSchema,
  dailyStoryReviewResponseSchema,
  isDashScopeBaseUrl,
  isDashScopeFunAsrHttpModel,
} from "@kotoba/contracts";
import { authenticatedApiFetch } from "@/lib/practice/api";
import { MAX_NORMALIZED_AUDIO_BYTES, normalizeRecordedAudio } from "@/lib/practice/audio-format";
import { apiBaseUrl } from "@/lib/practice/mode";
export {
  dailyApiErrorFromTransport,
  DailyApiError,
  isDailyStoryAbortError,
} from "./daily-api-errors";
import {
  dailyApiErrorFromTransport,
  DailyApiError,
  isDailyStoryAbortError,
} from "./daily-api-errors";
import {
  checkDashScopeFunAsrDirectProvider,
  isDashScopeFunAsrDirectEnabled,
  transcribeWithDashScopeFunAsrDirect,
} from "./asr-direct";
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
  title: z.string().min(1).optional(),
});
const replySchema = z.object({
  understanding: z.enum(["understood", "clarify", "retry"]),
  reply: z.string().min(1),
});
const transcriptSchema = z.object({
  transcript: z.string(),
  rawTranscript: z.string().optional(),
  normalizedTranscript: z.string().optional(),
  changes: z.array(faithfulTranscriptChangeSchema).optional(),
});
// New scoring fields stay optional while old API instances roll forward.
const reviewSchema = dailyStoryReviewResponseSchema;
const checkSchema = z.object({
  capability: z.enum(["chat", "asr", "tts"]),
  status: z.literal("connected"),
});

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
    throw dailyApiErrorFromTransport(error, signal);
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
  chat?: ChatProvider;
  storyZh?: string;
  history?: DailyMessage[];
  directAsr?: boolean;
  signal?: AbortSignal;
}) {
  // Fun-ASR HTTP accepts only WAV/MP3. Ordinary compatible providers may
  // accept the browser's original WebM/Ogg/MP4 when local decoding is absent.
  const requireWav =
    isDashScopeBaseUrl(input.asr.baseUrl) && isDashScopeFunAsrHttpModel(input.asr.model);
  const normalized = await normalizeRecordedAudio(input.audio, {
    strict: requireWav,
  });
  if (normalized.blob.size > MAX_NORMALIZED_AUDIO_BYTES) {
    throw new Error("录音超过 25 MiB 限制，请缩短录音后重试。");
  }
  const effectiveDirectAsr = isDashScopeFunAsrDirectEnabled(input.asr, input.directAsr === true);
  if (effectiveDirectAsr) {
    const direct = await transcribeWithDashScopeFunAsrDirect(
      input.asr,
      normalized.blob,
      normalized.mimeType,
      input.signal,
    );
    return normalizeTranscriptBestEffort({
      rawTranscript: direct.transcript,
      ...(input.chat ? { chat: input.chat } : {}),
      ...(input.storyZh ? { storyZh: input.storyZh } : {}),
      ...(input.history ? { history: input.history } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  const form = new FormData();
  form.set("audio", normalized.blob, `recording.${extension(normalized.mimeType)}`);
  form.set("asr", json(input.asr));
  if (input.chat) form.set("chat", json(input.chat));
  if (input.storyZh) form.set("storyZh", input.storyZh);
  if (input.history?.length) form.set("recentHistory", json(recentHistory(input.history)));
  return request("/api/daily-story/transcribe", transcriptSchema, form, input.signal);
}

async function normalizeTranscriptBestEffort(input: {
  rawTranscript: string;
  chat?: ChatProvider;
  storyZh?: string;
  history?: DailyMessage[];
  signal?: AbortSignal;
}) {
  const fallback = {
    transcript: input.rawTranscript,
    rawTranscript: input.rawTranscript,
    normalizedTranscript: input.rawTranscript,
    changes: [],
  };
  if (!input.chat) return { transcript: input.rawTranscript };
  try {
    const result = await request(
      "/api/daily-story/normalize-transcript",
      transcriptSchema,
      json({
        rawTranscript: input.rawTranscript,
        chat: input.chat,
        ...(input.storyZh ? { storyZh: input.storyZh } : {}),
        ...(input.history?.length ? { recentHistory: recentHistory(input.history) } : {}),
      }),
      input.signal,
    );
    return {
      transcript: result.normalizedTranscript ?? result.transcript,
      rawTranscript: result.rawTranscript ?? input.rawTranscript,
      normalizedTranscript: result.normalizedTranscript ?? result.transcript,
      changes: result.changes ?? [],
    };
  } catch {
    return fallback;
  }
}

function recentHistory(history: DailyMessage[]) {
  return history.slice(-8).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.role === "user" ? { source: message.source ?? "typed" } : {}),
  }));
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
    json({
      storyZh: input.storyZh,
      history: publicHistory(input.history),
      turn: publicTurn(input.turn),
      chat: input.chat,
    }),
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
  const result = await request(
    "/api/daily-story/review",
    reviewSchema,
    json({ ...body, history: publicHistory(input.history) }),
    signal,
  );
  return {
    score: result.score ?? null,
    comment: result.comment ?? null,
    rubric: result.rubric ?? null,
    overallFeedback: result.overallFeedback ?? null,
    suggestions: result.suggestions.map((suggestion) => ({
      sourceTurnId: suggestion.sourceTurnId,
      original: suggestion.original,
      improved: suggestion.improved,
      category: suggestion.category,
      explanationZh: suggestion.explanationZh,
      ...(suggestion.diff ? { diff: suggestion.diff } : {}),
    })),
  };
}

export async function checkDailyProvider(input: {
  capability: DailyCapability;
  provider: NonNullable<ProviderSettings[DailyCapability]>;
  directAsr?: boolean;
  signal?: AbortSignal;
}) {
  const effectiveDirectAsr =
    input.capability === "asr" &&
    isDashScopeFunAsrDirectEnabled(input.provider as AsrProvider, input.directAsr === true);
  if (effectiveDirectAsr) {
    await checkDashScopeFunAsrDirectProvider(input.provider as AsrProvider, input.signal);
    return { capability: "asr" as const, status: "connected" as const };
  }
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
    throw dailyApiErrorFromTransport(error, input.signal);
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

function publicHistory(history: DailyMessage[]) {
  return history.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.role === "user" ? { source: message.source ?? "typed" } : {}),
  }));
}

function publicTurn(turn: { id: string; source: TurnSource; text: string }) {
  return { id: turn.id, source: turn.source, text: turn.text };
}
