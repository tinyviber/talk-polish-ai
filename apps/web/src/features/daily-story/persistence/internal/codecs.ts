import {
  DAILY_STORY_LIMITS,
  dailyStoryAsrConfigSchema,
  dailyStoryChatConfigSchema,
  dailyStoryTtsConfigSchema,
  identifyProviderPreset,
  normalizeProviderBaseUrl,
} from "@kotoba/contracts";
import type {
  AsrProvider,
  ChatProvider,
  DailyCapability,
  DailyReview,
  ProviderSettings,
  ReviewRubric,
  StorySession,
  StorySessionSnapshot,
  TtsProvider,
} from "../../types";
import { createId } from "../../types";
import { CURRENT } from "./database";
import { DailyStorageError } from "../errors";
import {
  settingsSchema,
  sessionSchema,
  storedReviewSidecarSchema,
  storyExportSessionSchema,
  type StoredReviewSidecar,
  type StoredSession,
  type StoredSettings,
  type StoryExportSession,
} from "./schemas";

export type DailyReviewSidecar = Pick<DailyReview, "score" | "comment" | "rubric"> & {
  overallFeedback?: string | null;
  sessionRevision?: number;
  sessionInstanceId?: string;
};

export function fromStoredSettings(value: StoredSettings): ProviderSettings {
  const normalize = <
    T extends {
      baseUrl: string;
      apiKey: string;
      model: string;
      preset?: import("@kotoba/contracts").ProviderPresetId | undefined;
    },
  >(
    provider: T,
  ): Omit<T, "preset"> & { preset?: import("@kotoba/contracts").ProviderPresetId } => {
    let baseUrl = provider.baseUrl.trim();
    try {
      baseUrl = normalizeProviderBaseUrl(baseUrl);
    } catch {
      // Preserve malformed legacy data so the user can repair it in Settings.
    }
    const preset = identifyProviderPreset(baseUrl);
    const { preset: _storedPreset, ...providerWithoutPreset } = provider;
    return {
      ...providerWithoutPreset,
      baseUrl,
      ...(preset ? { preset } : {}),
    };
  };
  const asr = value.asr
    ? normalize({
        baseUrl: value.asr.baseUrl,
        apiKey: value.asr.apiKey,
        model: value.asr.model,
        ...(value.asr.preset ? { preset: value.asr.preset } : {}),
        ...(value.asr.responseFormat ? { responseFormat: value.asr.responseFormat } : {}),
      })
    : undefined;
  const chat = value.chat ? normalize(value.chat) : undefined;
  const tts = value.tts ? normalize(value.tts) : undefined;
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(chat ? { chat } : {}),
    ...(asr ? { asr } : {}),
    ...(value.local?.asrDirect ? { local: { asrDirect: true } } : {}),
    ...(tts ? { tts } : {}),
  };
}

export function fromStoredSession(value: StoredSession): StorySession {
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    ...(value.sessionInstanceId ? { sessionInstanceId: value.sessionInstanceId } : {}),
    updatedAt: value.updatedAt,
    phase: value.phase,
    storyZh: value.storyZh,
    ...(value.title ? { title: value.title } : {}),
    messages: value.messages.map((item) => ({
      id: item.id,
      role: item.role,
      text: item.text,
      ...(item.source ? { source: item.source } : {}),
      ...(item.rawText ? { rawText: item.rawText } : {}),
    })),
    ...(value.pendingAsrTranscript
      ? {
          pendingAsrTranscript: {
            id: value.pendingAsrTranscript.id,
            text: value.pendingAsrTranscript.text,
            ...(value.pendingAsrTranscript.rawText
              ? { rawText: value.pendingAsrTranscript.rawText }
              : {}),
          },
        }
      : {}),
    ...(value.review
      ? {
          review: {
            score: null,
            comment: null,
            overallFeedback: null,
            rubric: null,
            suggestions: value.review.suggestions.map((suggestion) => ({
              sourceTurnId: suggestion.sourceTurnId,
              original: suggestion.original,
              improved: suggestion.improved,
              category: suggestion.category,
              explanationZh: suggestion.explanationZh,
              ...(suggestion.diff ? { diff: suggestion.diff } : {}),
            })),
          },
        }
      : {}),
  };
}

export function sidecarRecord(
  conversationId: string,
  review: DailyReviewSidecar,
): StoredReviewSidecar {
  const parsed = storedReviewSidecarSchema.parse({
    conversationId,
    score: review.score,
    comment: review.comment,
    rubric: review.rubric,
    ...(review.overallFeedback !== undefined ? { overallFeedback: review.overallFeedback } : {}),
    ...(review.sessionRevision !== undefined ? { sessionRevision: review.sessionRevision } : {}),
    ...(review.sessionInstanceId ? { sessionInstanceId: review.sessionInstanceId } : {}),
  });
  return {
    conversationId: parsed.conversationId,
    score: parsed.score,
    comment: parsed.comment,
    rubric: parsed.rubric,
    ...(parsed.overallFeedback !== undefined ? { overallFeedback: parsed.overallFeedback } : {}),
    ...(parsed.sessionRevision !== undefined ? { sessionRevision: parsed.sessionRevision } : {}),
    ...(parsed.sessionInstanceId ? { sessionInstanceId: parsed.sessionInstanceId } : {}),
  };
}

export function mergeReview(
  session: StorySession,
  sidecar: DailyReviewSidecar | null,
): StorySession {
  if (!session.review) return session;
  return {
    ...session,
    review: {
      score: sidecar?.score ?? null,
      comment: sidecar?.comment ?? null,
      overallFeedback: sidecar?.overallFeedback ?? null,
      rubric: sidecar?.rubric ?? null,
      suggestions: session.review.suggestions,
    },
  };
}

export function settingsRecord(settings: ProviderSettings): StoredSettings {
  return settingsSchema.parse({ id: CURRENT, ...settings });
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

export function sessionRecord(session: StorySession, conversationId: string): StoredSession {
  const { review, ...withoutReview } = session;
  return sessionSchema.parse({
    id: conversationId,
    ...withoutReview,
    ...(review ? { review: { suggestions: review.suggestions } } : {}),
  });
}

export function exportSessionRecord(
  value: unknown,
  reviewSidecar: DailyReviewSidecar | null,
): StoryExportSession {
  const parsed = sessionSchema.parse(value);
  const projected = {
    id: parsed.id,
    updatedAt: parsed.updatedAt,
    phase: parsed.phase,
    storyZh: parsed.storyZh,
    messages: parsed.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.source ? { source: message.source } : {}),
      ...(message.rawText ? { rawText: message.rawText } : {}),
    })),
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.pendingAsrTranscript ? { pendingAsrTranscript: parsed.pendingAsrTranscript } : {}),
    ...(parsed.review
      ? {
          review: {
            ...parsed.review,
            score: reviewSidecar?.score ?? null,
            comment: reviewSidecar?.comment ?? null,
            ...(reviewSidecar?.overallFeedback
              ? { overallFeedback: reviewSidecar.overallFeedback }
              : {}),
            rubric: reviewSidecar?.rubric ?? null,
          },
        }
      : {}),
  };
  return storyExportSessionSchema.parse(projected);
}

export function importedSessionRecord(session: StoryExportSession): StoredSession {
  return sessionSchema.parse({
    id: session.id,
    schemaVersion: 1,
    revision: 1,
    sessionInstanceId: createId("session"),
    updatedAt: session.updatedAt,
    phase: session.phase,
    storyZh: session.storyZh,
    ...(session.title ? { title: session.title } : {}),
    messages: session.messages,
    ...(session.pendingAsrTranscript ? { pendingAsrTranscript: session.pendingAsrTranscript } : {}),
    ...(session.review ? { review: { suggestions: session.review.suggestions } } : {}),
  });
}

export function importedReviewSidecar(
  session: StoryExportSession,
  sessionInstanceId?: string,
): DailyReviewSidecar | null {
  if (!session.review) return null;
  return {
    score: session.review.score ?? null,
    comment: session.review.comment ?? null,
    overallFeedback: session.review.overallFeedback ?? null,
    rubric: session.review.rubric ?? null,
    sessionRevision: 1,
    ...(sessionInstanceId ? { sessionInstanceId } : {}),
  };
}

export function transferBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeProviderForStorage<T extends ChatProvider>(provider: T): T {
  try {
    const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
    if (!baseUrl.startsWith("https://")) throw new TypeError("HTTPS required");
    const preset = identifyProviderPreset(baseUrl);
    const { preset: _providedPreset, ...providerWithoutPreset } = provider;
    return {
      ...providerWithoutPreset,
      baseUrl,
      ...(preset ? { preset } : {}),
    } as T;
  } catch {
    throw new DailyStorageError("Endpoint 必须是有效的 HTTPS Base URL。请检查地址后重试。");
  }
}

export function validateProviderForStorage(
  capability: DailyCapability,
  provider: ChatProvider | AsrProvider | TtsProvider,
) {
  try {
    if (capability === "chat") return dailyStoryChatConfigSchema.parse(provider);
    if (capability === "asr") return dailyStoryAsrConfigSchema.parse(provider);
    return dailyStoryTtsConfigSchema.parse(provider);
  } catch {
    const label = capability === "chat" ? "Chat" : capability.toUpperCase();
    throw new DailyStorageError(
      `${label} 配置与当前 provider 能力或 Daily Story 参数限制不匹配，请检查 endpoint、model、API Key${capability === "asr" ? " 和 responseFormat" : capability === "tts" ? " 和 voice" : ""} 后重试。`,
    );
  }
}
