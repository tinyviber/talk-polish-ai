import {
  attemptResponseSchema,
  createAnonymousLearnerRequestSchema,
  deleteSavedExpressionResponseSchema,
  errorResponseSchema,
  learnerResponseSchema,
  practiceSessionResponseSchema,
  progressResponseSchema,
  promptsResponseSchema,
  savedExpressionResponseSchema,
  savedExpressionsResponseSchema,
  synthesisResponseSchema,
  type Expression,
  type Feedback,
  type Lang,
  type Learner,
  type Prompt,
  type Progress,
  type PracticeSession,
  type SavedExpression,
  type SynthesisRequest,
} from "@kotoba/contracts";
import { apiBaseUrl } from "./mode";

const DEVICE_KEY = "kotoba.api.device.v1";

function readStorage(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // API credentials can be recreated through anonymous bootstrap.
  }
}

// The learner id is only a local queue namespace. API authorization still
// relies on the signed token and server verification below.
function learnerIdFromToken(value: string | null) {
  if (typeof window === "undefined" || !value) return null;
  try {
    const encoded = value.split(".")[1];
    if (!encoded) return null;
    const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    return payload &&
      typeof payload === "object" &&
      "sub" in payload &&
      typeof payload.sub === "string"
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

// Bearer tokens stay in memory. A reload bootstraps the same anonymous learner
// from the durable device id instead of exposing credentials to localStorage.
let token: string | null = null;
let deviceId: string | null = readStorage(DEVICE_KEY);
let learnerId: string | null = learnerIdFromToken(token);
let lastBootstrapLang: Lang | null = null;
const bootstrapInFlight = new Map<Lang | null, Promise<Learner>>();
const REQUEST_TIMEOUT_MS = 30_000;
const READ_RETRY_LIMIT = 2;

/** Current learner namespace for local offline recordings. Never trust this as API auth. */
export function getLearnerId() {
  return learnerId;
}

/** Stable local namespace available before an anonymous API bootstrap succeeds. */
export function getQueueLearnerId() {
  return `device:${getDeviceId()}`;
}

/** Include the stable namespace and the server id for queues created by older builds. */
export function getQueueLearnerIds() {
  return [...new Set([getQueueLearnerId(), learnerId].filter((value): value is string => !!value))];
}

/** Build same-origin API URLs; never attach bearer tokens to arbitrary origins. */
export function apiUrl(path: string) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  // Empty VITE_API_URL is same-origin. An explicit URL (including local
  // development's http://localhost:3333) must stay absolute and is never
  // accidentally prefixed with the current browser origin.
  const base = apiBaseUrl ? new URL(`${apiBaseUrl}/`) : new URL("/", origin);
  const target = new URL(path, base);
  if (target.origin !== base.origin)
    throw new ApiClientError("Invalid API URL.", 0, "internal_error");
  return target.toString();
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code = "internal_error", requestId?: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function getDeviceId() {
  if (deviceId) return deviceId;
  deviceId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `device-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  writeStorage(DEVICE_KEY, deviceId);
  return deviceId;
}

async function request<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init: RequestInit = {},
  authenticated = true,
): Promise<T> {
  const response = await fetchWithRetry(path, init, authenticated);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiErrorFromResponse(response, payload, "The API");
  try {
    return schema.parse(payload);
  } catch {
    throw new ApiClientError("The API returned an invalid response.", response.status);
  }
}

async function fetchWithRetry(
  path: string,
  init: RequestInit = {},
  authenticated = true,
  refreshAttempted = false,
): Promise<Response> {
  if (authenticated && !token) await bootstrapLearner(lastBootstrapLang);
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  if (authenticated) {
    if (!token) throw new ApiClientError("The learner session has expired.", 401, "unauthorized");
    headers.set("authorization", `Bearer ${token}`);
  }

  const method = (init.method ?? "GET").toUpperCase();
  const retryLimit = method === "GET" || method === "HEAD" ? READ_RETRY_LIMIT : 0;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl(path), {
        ...init,
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 && authenticated && !refreshAttempted) {
        token = null;
        learnerId = null;
        await bootstrapLearner(lastBootstrapLang);
        return fetchWithRetry(path, init, authenticated, true);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (attempt >= retryLimit) {
        throw new ApiClientError(
          controller.signal.aborted
            ? "The API request timed out. Please try again."
            : "The API could not be reached. Check that it is running.",
          0,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw new ApiClientError("The API request failed.", 0);
}

/** Shared authenticated transport for isolated feature modules. Keeps learner token memory-only. */
export async function authenticatedApiFetch(path: string, init: RequestInit = {}) {
  return fetchWithRetry(path, init, true);
}

function apiErrorFromResponse(response: Response, payload: unknown, prefix: string) {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiClientError(
      parsed.data.error.message,
      response.status,
      parsed.data.error.code,
      parsed.data.requestId,
    );
  }
  return new ApiClientError(`${prefix} returned an unexpected error.`, response.status);
}

export async function bootstrapLearner(lang: Lang | null): Promise<Learner> {
  const existing = bootstrapInFlight.get(lang);
  if (existing) return existing;

  const inFlight = bootstrapLearnerOnce(lang).finally(() => {
    if (bootstrapInFlight.get(lang) === inFlight) bootstrapInFlight.delete(lang);
  });
  bootstrapInFlight.set(lang, inFlight);
  return inFlight;
}

async function bootstrapLearnerOnce(lang: Lang | null) {
  const body = createAnonymousLearnerRequestSchema.parse({ deviceId: getDeviceId(), lang });
  const response = await request(
    "/api/learners/anonymous",
    learnerResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    false,
  );
  token = response.token;
  learnerId = response.learner.id;
  lastBootstrapLang = response.learner.lang;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("kotoba:learner-ready"));
  return response.learner;
}

export async function listPrompts(lang?: Lang): Promise<Prompt[]> {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  return (await request(`/api/prompts${query}`, promptsResponseSchema, {}, false)).prompts;
}

export async function createSession(
  promptId: string,
  clientSessionId?: string,
): Promise<PracticeSession> {
  if (!token) await bootstrapLearner(null);
  return (
    await request("/api/sessions", practiceSessionResponseSchema, {
      method: "POST",
      // The key is idempotent server-side, so a replayed offline session
      // resolves to the same practice session instead of a duplicate.
      body: JSON.stringify({ promptId, ...(clientSessionId ? { clientSessionId } : {}) }),
    })
  ).session;
}

export async function getSession(id: string): Promise<PracticeSession> {
  if (!token) await bootstrapLearner(null);
  return (await request(`/api/sessions/${encodeURIComponent(id)}`, practiceSessionResponseSchema))
    .session;
}

export async function createAttempt(
  sessionId: string,
  input: { clientAttemptId: string; index: 1 | 2; durationSec: number; audio: Blob | null },
) {
  if (!token) await bootstrapLearner(null);
  const form = new FormData();
  form.set("clientAttemptId", input.clientAttemptId);
  form.set("attemptIndex", String(input.index));
  form.set("durationSec", String(input.durationSec));
  if (input.audio) form.set("audio", input.audio, `recording.${audioExtension(input.audio.type)}`);
  else form.set("mocked", "true");
  return (
    await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/attempts`,
      attemptResponseSchema,
      { method: "POST", body: form },
    )
  ).attempt;
}

export async function uploadQueuedAttempt(item: {
  clientAttemptId: string;
  sessionId: string | null;
  clientSessionId?: string | undefined;
  promptId: string;
  attemptIndex: 1 | 2;
  duration: number;
  mimeType: string;
  blob: Blob;
  attemptId?: string | undefined;
  syncStatus?:
    "local-draft" | "queued" | "uploading" | "processing" | "ready" | "failed" | undefined;
}) {
  if (item.syncStatus === "processing" && item.attemptId) {
    const attempt = await getAttempt(item.attemptId);
    // GET performs stale recovery server-side. A recovered failed row is
    // reclaimable, so replay the original bytes with the same idempotency key.
    if (attempt.status !== "failed") return { attempt, sessionId: attempt.sessionId };
  }
  // A recording captured while offline may have no server session yet.
  const sessionId = item.sessionId ?? (await createSession(item.promptId, item.clientSessionId)).id;
  const attempt = await createAttempt(sessionId, {
    clientAttemptId: item.clientAttemptId,
    index: item.attemptIndex,
    durationSec: item.duration,
    audio: item.blob,
  });
  return { attempt, sessionId };
}

function audioExtension(mimeType: string) {
  const mime = mimeType.split(";")[0]?.toLowerCase();
  if (mime === "audio/mp4" || mime === "audio/m4a") return "m4a";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/mpeg") return "mp3";
  return "webm";
}

export async function getAttempt(id: string) {
  if (!token) await bootstrapLearner(null);
  return (await request(`/api/attempts/${encodeURIComponent(id)}`, attemptResponseSchema)).attempt;
}

export async function listSaved(): Promise<SavedExpression[]> {
  if (!token) await bootstrapLearner(null);
  return (await request("/api/saved", savedExpressionsResponseSchema)).expressions;
}

export async function saveExpression(expression: Expression): Promise<SavedExpression> {
  if (!token) await bootstrapLearner(null);
  return (
    await request("/api/saved", savedExpressionResponseSchema, {
      method: "POST",
      body: JSON.stringify({ expression }),
    })
  ).expression;
}

export async function deleteSaved(expressionId: string) {
  if (!token) await bootstrapLearner(null);
  return request(
    `/api/saved/${encodeURIComponent(expressionId)}`,
    deleteSavedExpressionResponseSchema,
    { method: "DELETE" },
  );
}

export async function getProgress(): Promise<Progress> {
  if (!token) await bootstrapLearner(null);
  return (await request("/api/progress", progressResponseSchema)).progress;
}

export async function synthesizeSpeech(input: SynthesisRequest) {
  if (!token) await bootstrapLearner(input.lang);
  return (
    await request("/api/tts", synthesisResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).audio;
}

/**
 * Fetch protected audio with bearer auth and return a browser object URL.
 * Caller owns URL.revokeObjectURL(url).
 */
export async function fetchAuthenticatedAudioUrl(playbackPath: string): Promise<string> {
  const response = await fetchWithRetry(playbackPath, { redirect: "error" });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw apiErrorFromResponse(response, payload, "The audio API");
  }
  return URL.createObjectURL(await response.blob());
}

export function toReadyAttempt(value: Awaited<ReturnType<typeof createAttempt>>) {
  if (value.status !== "ready" || !value.transcript || !value.feedback) {
    throw new ApiClientError(
      "The attempt did not finish processing.",
      503,
      "processing_unavailable",
    );
  }
  return {
    id: value.id,
    ...(value.clientAttemptId ? { clientAttemptId: value.clientAttemptId } : {}),
    sessionId: value.sessionId,
    status: value.status,
    audio: value.audio,
    index: value.index,
    transcript: value.transcript,
    feedback: value.feedback as Feedback,
    durationSec: value.durationSec,
    mocked: value.mocked,
  };
}
