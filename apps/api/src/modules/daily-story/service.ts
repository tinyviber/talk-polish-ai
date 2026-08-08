import { randomUUID } from "node:crypto";
import type {
  DailyStoryAsrConfig,
  DailyStoryChatConfig,
  DailyStoryHistoryMessage,
  DailyStoryProviderCheckRequest,
  DailyStoryReviewRequest,
  DailyStoryTtsConfig,
} from "@kotoba/contracts";
import type { Env } from "../../env";
import { ApiError } from "../../http/errors";
import { createStructuredGenerator } from "../../capabilities/structured-generator";
import {
  DailyProviderConfigurationError,
  DailyProviderDnsError,
} from "../../providers/outbound-url-policy";
import { DailyProviderRequestError } from "../../providers/safe-https-client";
import {
  createDailyStoryRequestProviders,
  type DailyStoryRequestProviders,
} from "../../providers/request-scoped";
import {
  conversationResultSchema,
  conversationSystemPrompt,
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
        const generated = await safeProviderCall(() =>
          createStructuredGenerator(chat).generate({
            schema: openingResultSchema,
            messages: [
              { role: "system", content: conversationSystemPrompt },
              { role: "user", content: openingUserPrompt(input.storyZh) },
            ],
            requestId: input.requestId,
            maxTokens: 220,
          }),
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
        const transcript = await safeProviderCall(() =>
          asr.transcribe({
            audio: input.audio,
            mimeType: input.mimeType,
            locale: "en",
            granularity: "text",
            requestId: input.requestId,
          }),
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
        const generated = await safeProviderCall(() =>
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
            maxTokens: 260,
          }),
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
        const generated = await safeProviderCall(() =>
          createStructuredGenerator(chat).generate({
            schema: reviewResultSchema,
            messages: [
              { role: "system", content: reviewSystemPrompt },
              {
                role: "user",
                content: reviewUserPrompt({ storyZh: input.storyZh, history: input.history }),
              },
            ],
            requestId: input.requestId,
            maxTokens: 520,
          }),
        );
        const seenSourceIds = new Set<string>();
        for (const suggestion of generated.value.suggestions) {
          if (
            sourceTurns.get(suggestion.sourceTurnId) !== suggestion.original ||
            seenSourceIds.has(suggestion.sourceTurnId)
          ) {
            throw ApiError.processingUnavailable(
              "Daily Story review could not be validated. Please retry.",
            );
          }
          seenSourceIds.add(suggestion.sourceTurnId);
        }
        return generated.value;
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
        return safeProviderCall(() =>
          tts.synthesize({
            text: input.text,
            voice: input.tts.voice,
            locale: "en",
            requestId: input.requestId,
          }),
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
          await safeProviderCall(async () => required(provider).check?.());
          return { capability: input.request.capability, status: "connected" as const };
        },
        true,
      );
    },
  };
}

function required<T>(value: T | undefined) {
  if (!value) throw new DailyProviderConfigurationError();
  return value;
}

async function safeProviderCall<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (
      error instanceof DailyProviderConfigurationError ||
      error instanceof DailyProviderDnsError
    ) {
      throw ApiError.validation("Daily Story provider configuration is invalid.");
    }
    // Do not expose upstream response body, URL, key, headers, or Error.cause.
    if (error instanceof DailyProviderRequestError) {
      throw ApiError.processingUnavailable("Daily Story provider is temporarily unavailable.");
    }
    throw ApiError.processingUnavailable("Daily Story provider is temporarily unavailable.");
  }
}

export type DailyStoryService = ReturnType<typeof createDailyStoryService>;
