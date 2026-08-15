import { createHash } from "node:crypto";
import {
  DAILY_STORY_SYNC_LIMITS,
  dailyStorySyncConflictResponseSchema,
  dailyStorySyncConversationSchema,
  dailyStorySyncListQuerySchema,
  dailyStorySyncListResponseSchema,
  dailyStorySyncParamsSchema,
  dailyStorySyncPushRequestSchema,
  dailyStorySyncPushResponseSchema,
  errorResponseSchema,
} from "@kotoba/contracts";
import type { FastifyInstance } from "fastify";
import { requireSyncAuth } from "../../auth";
import { ApiError } from "../../http/errors";
import {
  dailyStorySyncRepository,
  decodeSyncCursor,
  encodeSyncCursor,
  rowToRemoteObject,
} from "./repository";

const maxQueryRows = DAILY_STORY_SYNC_LIMITS.pageSize + 1;

export async function dailyStorySyncRoutes(app: FastifyInstance) {
  app.get(
    "/api/sync/conversations",
    {
      schema: {
        tags: ["sync"],
        summary: "List personal Daily Story sync objects",
        response: {
          200: dailyStorySyncListResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
        querystring: dailyStorySyncListQuerySchema,
      },
    },
    async (request) => {
      requireSyncAuth(request);
      const query = dailyStorySyncListQuerySchema.parse(request.query);
      let cursor;
      try {
        cursor = query.cursor ? decodeSyncCursor(query.cursor) : undefined;
      } catch {
        throw ApiError.validation("The sync cursor is invalid.");
      }
      const rows = await dailyStorySyncRepository.list(maxQueryRows, cursor);
      const page = rows.slice(0, DAILY_STORY_SYNC_LIMITS.pageSize);
      const last = page.at(-1);
      return {
        objects: page.map(rowToRemoteObject),
        nextCursor:
          rows.length > DAILY_STORY_SYNC_LIMITS.pageSize && last ? encodeSyncCursor(last) : null,
        requestId: request.id,
      };
    },
  );

  app.put(
    "/api/sync/conversations/:conversationId",
    {
      bodyLimit: DAILY_STORY_SYNC_LIMITS.objectBytes,
      schema: {
        tags: ["sync"],
        summary: "Create or compare-and-swap one personal Daily Story object",
        params: dailyStorySyncParamsSchema,
        body: dailyStorySyncPushRequestSchema,
        response: {
          200: dailyStorySyncPushResponseSchema,
          401: errorResponseSchema,
          409: dailyStorySyncConflictResponseSchema,
          429: errorResponseSchema,
          413: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      requireSyncAuth(request);
      const params = dailyStorySyncParamsSchema.parse(request.params);
      const body = dailyStorySyncPushRequestSchema.parse(request.body);
      if (
        body.object?.conversationId !== undefined &&
        body.object.conversationId !== params.conversationId
      ) {
        throw ApiError.validation("Conversation id does not match route.");
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > DAILY_STORY_SYNC_LIMITS.objectBytes) {
        throw ApiError.tooLarge("The sync object is too large.");
      }

      const object = body.object ? dailyStorySyncConversationSchema.parse(body.object) : null;
      const contentHash = hashObject(object);
      const mutationHash = hashObject({
        expectedRemoteRevision: body.expectedRemoteRevision,
        clientRevision: body.clientRevision,
        sessionInstanceId: body.sessionInstanceId ?? null,
        object,
      });
      const result = await dailyStorySyncRepository.apply(
        params.conversationId,
        { ...body, object },
        contentHash,
        mutationHash,
      );
      if (result.kind === "invalid_mutation") {
        throw ApiError.validation("The mutation id was reused with different content.");
      }
      if (result.kind === "conflict") {
        return reply.status(409).send({
          error: {
            code: "conflict",
            message: "The remote conversation changed. Keep both versions.",
          },
          current: result.row ? rowToRemoteObject(result.row) : null,
          requestId: request.id,
        });
      }
      return {
        status: result.idempotent ? "already_applied" : "accepted",
        mutationId: body.mutationId,
        object: rowToRemoteObject(result.row),
        requestId: request.id,
      };
    },
  );
}

function hashObject(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
