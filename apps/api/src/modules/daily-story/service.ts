import { randomUUID } from "node:crypto";
import {
  dailyStoryReviewDiffSchema,
  type DailyStoryAsrConfig,
  type DailyStoryChatConfig,
  type DailyStoryHistoryMessage,
  type DailyStoryProviderCheckRequest,
  type DailyStoryReviewDiffSegment,
  type DailyStoryReviewRequest,
  type DailyStoryTtsConfig,
} from "@kotoba/contracts";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import {
  createStructuredGenerator,
  StructuredGenerationError,
} from "../../capabilities/structured-generator";
import {
  DailyProviderConfigurationError,
  DailyProviderDnsError,
} from "../../providers/outbound-url-policy";
import { ProviderConfigurationError, ProviderRequestError } from "../../providers/http";
import { DailyProviderRequestError } from "../../providers/safe-https-client";
import {
  createDailyStoryRequestProviders,
  type DailyStoryRequestProviders,
} from "../../providers/request-scoped";
import {
  conversationResultSchema,
  conversationSystemPrompt,
  DAILY_STORY_OPENING_MAX_TOKENS,
  openingResultSchema,
  openingUserPrompt,
  replyUserPrompt,
  reviewResultSchema,
  reviewSystemPrompt,
  reviewUserPrompt,
} from "./policy";
import { withDailyStoryRequestGuard } from "./request-guards";

type ProviderFactory = (
  config: Env,
  input: Partial<{
    chat: DailyStoryChatConfig;
    asr: DailyStoryAsrConfig;
    tts: DailyStoryTtsConfig;
  }>,
) => Partial<DailyStoryRequestProviders>;

type Guard = typeof withDailyStoryRequestGuard;

const DAILY_STORY_REPLY_MAX_TOKENS = 512;
export const DAILY_STORY_REVIEW_MAX_TOKENS = 1536;
const DAILY_STORY_REVIEW_HISTORY_CHARS = 12_000;
const DAILY_STORY_REVIEW_MAX_SUGGESTIONS = 2;

export function dailyStoryReviewComment(score: number) {
  if (score >= 90) return "本次表达整体清晰自然，可继续扩大表达范围。";
  if (score >= 75) return "本次表达整体稳定，针对细节继续打磨会更自然。";
  if (score >= 60) return "本次表达基本清楚，继续针对分项薄弱处练习。";
  return "本次表达基础仍需加强，建议优先结合四项分项反馈练习。";
}

export function createDailyStoryService(
  config: Env,
  dependencies: { providerFactory?: ProviderFactory; guard?: Guard } = {},
) {
  const providerFactory = dependencies.providerFactory ?? createDailyStoryRequestProviders;
  const guard = dependencies.guard ?? withDailyStoryRequestGuard;
  const guarded = <T>(
    learnerId: string,
    ip: string | undefined,
    capability: string,
    run: () => Promise<T>,
    providerCheck = false,
  ) =>
    guard({
      learnerId,
      ip,
      capability,
      perMinute: providerCheck
        ? config.DAILY_STORY_PROVIDER_CHECK_RATE_LIMIT_PER_MINUTE
        : config.DAILY_STORY_RATE_LIMIT_PER_MINUTE,
      concurrent: config.DAILY_STORY_CONCURRENT_REQUESTS,
      run,
    });

  return {
    async start(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      storyZh: string;
      chat: DailyStoryChatConfig;
    }) {
      return guarded(input.learnerId, input.ip, "chat", async () => {
        const chat = required(providerFactory(config, { chat: input.chat }).chat);
        const generated = await safeProviderCall(
          config,
          () =>
            createStructuredGenerator(chat).generate({
              schema: openingResultSchema,
              messages: [
                { role: "system", content: conversationSystemPrompt },
                { role: "user", content: openingUserPrompt(input.storyZh) },
              ],
              requestId: input.requestId,
              maxTokens: DAILY_STORY_OPENING_MAX_TOKENS,
            }),
          input.requestId,
        );
        return {
          opening: { id: randomUUID(), role: "assistant" as const, text: generated.value.reply },
        };
      });
    },

    async transcribe(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      asr: DailyStoryAsrConfig;
      audio: Uint8Array;
      mimeType: string;
    }) {
      return guarded(input.learnerId, input.ip, "asr", async () => {
        const asr = required(providerFactory(config, { asr: input.asr }).asr);
        const transcript = await safeProviderCall(
          config,
          () =>
            asr.transcribe({
              audio: input.audio,
              mimeType: input.mimeType,
              locale: "en",
              granularity: "text",
              requestId: input.requestId,
            }),
          input.requestId,
        );
        return { transcript: transcript.text };
      });
    },

    async reply(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      storyZh: string;
      history: DailyStoryHistoryMessage[];
      turn: { id: string; source: "asr" | "typed"; text: string };
      chat: DailyStoryChatConfig;
    }) {
      return guarded(input.learnerId, input.ip, "chat", async () => {
        if (input.history.some((message) => message.id === input.turn.id)) {
          throw ApiError.validation("Conversation turn id must be new.");
        }
        const chat = required(providerFactory(config, { chat: input.chat }).chat);
        const generated = await safeProviderCall(
          config,
          () =>
            createStructuredGenerator(chat).generate({
              schema: conversationResultSchema,
              messages: [
                { role: "system", content: conversationSystemPrompt },
                {
                  role: "user",
                  content: replyUserPrompt({
                    storyZh: input.storyZh,
                    history: input.history,
                    turn: { ...input.turn, role: "user" },
                  }),
                },
              ],
              requestId: input.requestId,
              maxTokens: DAILY_STORY_REPLY_MAX_TOKENS,
            }),
          input.requestId,
        );
        return generated.value;
      });
    },

    async review(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      storyZh: string;
      history: DailyStoryHistoryMessage[];
      chat: DailyStoryChatConfig;
    }) {
      return guarded(input.learnerId, input.ip, "review", async () => {
        const sourceTurns = new Map(
          input.history
            .filter(
              (message): message is Extract<DailyStoryHistoryMessage, { role: "user" }> =>
                message.role === "user",
            )
            .map((message) => [message.id, message.text]),
        );
        if (sourceTurns.size === 0)
          throw ApiError.validation("Conversation needs a user turn before review.");
        const chat = required(providerFactory(config, { chat: input.chat }).chat);
        const reviewHistory = selectReviewHistory(input.history);
        const generated = await safeProviderCall(
          config,
          () =>
            createStructuredGenerator(chat).generate({
              schema: reviewResultSchema,
              repairInstruction:
                "Return only JSON with the exact rubric and suggestions shape from the system instruction. Even when there are no useful improvements, include the complete rubric with fluency, grammar, vocabulary, and naturalness, and set only suggestions to []. Never omit rubric. Do not return a total score or top-level comment. Each evidence quote must be an exact continuous substring of its referenced user turn.",
              messages: [
                { role: "system", content: reviewSystemPrompt },
                {
                  role: "user",
                  content: reviewUserPrompt({ storyZh: input.storyZh, history: reviewHistory }),
                },
              ],
              requestId: input.requestId,
              maxTokens: DAILY_STORY_REVIEW_MAX_TOKENS,
            }),
          input.requestId,
        );
        const seenSourceIds = new Set<string>();
        const suggestions = [];
        for (const suggestion of generated.value.suggestions.slice(
          0,
          DAILY_STORY_REVIEW_MAX_SUGGESTIONS,
        )) {
          const original = sourceTurns.get(suggestion.sourceTurnId);
          if (original === undefined) {
            console.warn("[daily-story review suggestion skipped]", {
              requestId: input.requestId,
              reason: "unknown_source_turn",
            });
            continue;
          }
          if (seenSourceIds.has(suggestion.sourceTurnId)) {
            console.warn("[daily-story review suggestion skipped]", {
              requestId: input.requestId,
              reason: "duplicate_source_turn",
            });
            continue;
          }
          seenSourceIds.add(suggestion.sourceTurnId);
          const diff = reconstructReviewDiff(original, suggestion.diff);
          if (diff === null) {
            console.warn("[daily-story review diff fallback]", {
              requestId: input.requestId,
              sourceTurnId: suggestion.sourceTurnId,
              originalChars: original.length,
              diffSegments: Array.isArray(suggestion.diff) ? suggestion.diff.length : null,
            });
          }
          suggestions.push({
            sourceTurnId: suggestion.sourceTurnId,
            original,
            improved: suggestion.improved,
            category: suggestion.category,
            explanationZh: suggestion.explanationZh,
            ...(diff ? { diff } : {}),
          });
        }
        const rubric = normalizeReviewRubric(generated.value.rubric, sourceTurns, input.requestId);
        const score = Math.round(
          (rubric.fluency.score +
            rubric.grammar.score +
            rubric.vocabulary.score +
            rubric.naturalness.score) /
            4,
        );
        return {
          score,
          comment: dailyStoryReviewComment(score),
          rubric,
          suggestions,
        };
      });
    },

    async tts(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      text: string;
      tts: DailyStoryTtsConfig;
    }) {
      return guarded(input.learnerId, input.ip, "tts", async () => {
        const tts = required(providerFactory(config, { tts: input.tts }).tts);
        return safeProviderCall(
          config,
          () =>
            tts.synthesize({
              text: input.text,
              voice: input.tts.voice,
              locale: "en",
              requestId: input.requestId,
            }),
          input.requestId,
        );
      });
    },

    async providerCheck(input: {
      learnerId: string;
      ip?: string;
      requestId: string;
      request: DailyStoryProviderCheckRequest;
    }) {
      return guarded(
        input.learnerId,
        input.ip,
        `check:${input.request.capability}`,
        async () =>
          safeProviderCall(
            config,
            async () => {
              const providers = providerFactory(config, {
                [input.request.capability]: input.request.provider,
              });
              const provider =
                input.request.capability === "chat"
                  ? providers.chat
                  : input.request.capability === "asr"
                    ? providers.asr
                    : providers.tts;
              await required(provider).check?.(input.requestId);
              return { capability: input.request.capability, status: "connected" as const };
            },
            input.requestId,
          ),
        true,
      );
    },
  };
}

function required<T>(value: T | undefined) {
  if (!value) throw new DailyProviderConfigurationError();
  return value;
}

function selectReviewHistory(history: DailyStoryHistoryMessage[]) {
  const userTurns = history
    .filter(
      (message): message is Extract<DailyStoryHistoryMessage, { role: "user" }> =>
        message.role === "user",
    )
    .map(({ id, text }) => ({ id, text }));
  const selected: Array<{ id: string; text: string }> = [];
  let chars = 0;
  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const turn = userTurns[index]!;
    if (chars > 0 && chars + turn.text.length > DAILY_STORY_REVIEW_HISTORY_CHARS) continue;
    selected.unshift(turn);
    chars += turn.text.length;
    if (chars >= DAILY_STORY_REVIEW_HISTORY_CHARS) break;
  }
  return selected;
}

function normalizeReviewRubric(
  rubric: {
    fluency: {
      score: number;
      comment: string;
      evidence: Array<{ sourceTurnId: string; quote: string }>;
    };
    grammar: {
      score: number;
      comment: string;
      evidence: Array<{ sourceTurnId: string; quote: string }>;
    };
    vocabulary: {
      score: number;
      comment: string;
      evidence: Array<{ sourceTurnId: string; quote: string }>;
    };
    naturalness: {
      score: number;
      comment: string;
      evidence: Array<{ sourceTurnId: string; quote: string }>;
    };
  },
  sourceTurns: Map<string, string>,
  requestId: string,
) {
  const normalized = Object.fromEntries(
    Object.entries(rubric).map(([dimension, item]) => [
      dimension,
      {
        ...item,
        evidence: item.evidence.filter((evidence) => {
          const source = sourceTurns.get(evidence.sourceTurnId);
          const valid = source !== undefined && source.includes(evidence.quote);
          if (!valid) {
            console.warn("[daily-story review evidence skipped]", {
              requestId,
              dimension,
              reason: source === undefined ? "unknown_source_turn" : "quote_not_in_source",
            });
          }
          return valid;
        }),
      },
    ]),
  );
  return normalized as typeof rubric;
}

function reconstructReviewDiff(
  original: string,
  diff: unknown,
): DailyStoryReviewDiffSegment[] | null {
  const parsed = dailyStoryReviewDiffSchema.safeParse(diff);
  if (!parsed.success) return null;
  let reconstructed = "";
  for (const [, text] of parsed.data) {
    reconstructed += text;
  }
  return reconstructed === original ? parsed.data : null;
}

async function safeProviderCall<T>(config: Env, run: () => Promise<T>, requestId?: string) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error) {
      console.warn("[daily-story provider error]", {
        ...(requestId ? { requestId } : {}),
        name: error.constructor.name,
        message: error.message,
        ...(error instanceof DailyProviderRequestError || error instanceof ProviderRequestError
          ? {
              code: error.code,
              status: error.status,
              ...(error instanceof DailyProviderRequestError && error.reason
                ? { reason: error.reason }
                : {}),
            }
          : {}),
        ...(error instanceof StructuredGenerationError
          ? { schemaIssues: structuredSchemaIssues(error.cause) }
          : {}),
      });
    }
    if (
      error instanceof DailyProviderConfigurationError ||
      error instanceof DailyProviderDnsError ||
      error instanceof ProviderConfigurationError
    ) {
      throw ApiError.validation("Daily Story provider configuration is invalid.");
    }
    // Do not expose upstream response body, URL, key, headers, or Error.cause.
    if (error instanceof DailyProviderRequestError || error instanceof ProviderRequestError) {
      // Preserve actionable provider errors for the UI. The transport keeps the
      // upstream status without exposing its response body or credentials.
      if (error.status === 401 || error.status === 403) {
        throw ApiError.unauthorized("Daily Story provider credentials were rejected.");
      }
      if (error.status === 429) {
        throw ApiError.rateLimited(
          "Daily Story provider rate limit reached. Please try again later.",
        );
      }
      if (error.status === 400 || error.status === 404 || error.status === 405) {
        const reason =
          config.NODE_ENV !== "production" &&
          error instanceof DailyProviderRequestError &&
          error.reason
            ? `Daily Story provider rejected the request: ${error.reason}`
            : "Daily Story provider configuration is invalid.";
        throw ApiError.validation(reason);
      }
      if (error instanceof DailyProviderRequestError && error.code === "unsupported_media") {
        throw ApiError.unsupportedMedia("Fun-ASR 仅支持 WAV 或 MP3 音频。请重新录音后重试。");
      }
      throw ApiError.processingUnavailable("Daily Story provider is temporarily unavailable.");
    }
    throw ApiError.processingUnavailable("Daily Story provider is temporarily unavailable.");
  }
}

function structuredSchemaIssues(cause: unknown) {
  if (!cause || typeof cause !== "object") return [];
  const record = cause as { first?: unknown; repair?: unknown };
  return [
    ["first", record.first],
    ["repair", record.repair],
  ].flatMap(([label, value]) => {
    if (!value || typeof value !== "object") return [];
    const item = value as { error?: { issues?: unknown }; shape?: unknown };
    const issues = item.error?.issues;
    if (!Array.isArray(issues)) return [];
    const result = issues.slice(0, 8).flatMap((issue) => {
      if (!issue || typeof issue !== "object") return [];
      const item = issue as { path?: unknown; code?: unknown };
      return [
        {
          attempt: label,
          path: Array.isArray(item.path) ? item.path.slice(0, 6) : [],
          code: typeof item.code === "string" ? item.code : "unknown",
        },
      ];
    });
    return item.shape ? [...result, { attempt: label, shape: item.shape }] : result;
  });
}

export type DailyStoryService = ReturnType<typeof createDailyStoryService>;
