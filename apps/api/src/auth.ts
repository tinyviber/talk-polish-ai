import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "./env";
import { ApiError } from "./http/errors";
import { requireLearner } from "./modules/learners/service";

type LearnerTokenPayload = {
  sub: string;
  scope: "learner";
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(value: string) {
  return createHmac("sha256", env().ANON_TOKEN_SECRET).update(value).digest("base64url");
}

export function issueLearnerToken(learnerId: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encode(
    JSON.stringify({
      sub: learnerId,
      scope: "learner",
      iat: now,
      exp: now + env().ANON_TOKEN_TTL_SEC,
    }),
  );
  return `v1.${payload}.${sign(`v1.${payload}`)}`;
}

export function verifyLearnerToken(token: string): LearnerTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw ApiError.unauthorized();

  const signed = `${parts[0]}.${parts[1]}`;
  const expected = sign(signed);
  const providedBytes = encoder.encode(parts[2]!);
  const expectedBytes = encoder.encode(expected);
  if (
    providedBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    throw ApiError.unauthorized();
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    if (
      !payload ||
      typeof payload !== "object" ||
      !("sub" in payload) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !("scope" in payload) ||
      payload.scope !== "learner"
    ) {
      throw ApiError.unauthorized();
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !("iat" in payload) ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      !("exp" in payload) ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > now + 60 ||
      payload.exp <= now ||
      payload.iat > payload.exp
    ) {
      throw ApiError.unauthorized("The learner token has expired.");
    }
    return payload as LearnerTokenPayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.unauthorized();
  }
}

export async function requireLearnerAuth(request: FastifyRequest) {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw ApiError.unauthorized();
  const payload = verifyLearnerToken(match[1]!);
  return requireLearner(payload.sub);
}

/** Personal sync vault auth. Disabled when no digest is configured. */
const syncAuthFailures = new Map<string, { count: number; resetAt: number }>();
const SYNC_AUTH_WINDOW_MS = 15 * 60_000;
const SYNC_AUTH_MAX_FAILURES = 60;

export function verifySyncToken(token: string, configuredHash = env().SYNC_API_TOKEN_HASH) {
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = /^[a-f0-9]{64}$/i.test(configuredHash ?? "")
    ? Buffer.from(configuredHash!, "hex")
    : Buffer.alloc(actual.byteLength);
  const valid = Boolean(configuredHash) && timingSafeEqual(actual, expected);
  if (!valid) throw ApiError.unauthorized("A valid sync token is required.");
}

export function requireSyncAuth(request: FastifyRequest) {
  const key = request.ip || "unknown";
  const now = Date.now();
  const existing = syncAuthFailures.get(key);
  if (existing && existing.resetAt > now && existing.count >= SYNC_AUTH_MAX_FAILURES) {
    throw ApiError.rateLimited("Too many failed sync authentication attempts.");
  }
  if (existing && existing.resetAt <= now) syncAuthFailures.delete(key);

  const header = request.headers.authorization;
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  try {
    if (!match) throw ApiError.unauthorized("A valid sync token is required.");
    verifySyncToken(match[1]!);
    syncAuthFailures.delete(key);
  } catch (error) {
    const failed = syncAuthFailures.get(key);
    syncAuthFailures.set(key, {
      count: (failed?.count ?? 0) + 1,
      resetAt: failed?.resetAt && failed.resetAt > now ? failed.resetAt : now + SYNC_AUTH_WINDOW_MS,
    });
    throw error;
  }
}
