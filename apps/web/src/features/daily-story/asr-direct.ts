import {
  DASHSCOPE_FUN_ASR_NATIVE_PATH,
  resolveDashScopeFunAsrBrowserDirect,
} from "@kotoba/contracts";
import { DailyApiAbortedError, DailyApiError, isDailyStoryAbortError } from "./daily-api-errors";
import type { AsrProvider } from "./types";

const FUN_ASR_HTTP_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/opus",
]);
const FUN_ASR_PROBE_MP3_BASE64 =
  "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";

export function isDashScopeFunAsrDirectEnabled(provider: AsrProvider, enabled: boolean) {
  return enabled && resolveDashScopeFunAsrBrowserDirect(provider).supported;
}

export function getDashScopeFunAsrDirectSupport(
  provider: Pick<AsrProvider, "baseUrl" | "model">,
  enabled = false,
) {
  const resolution = resolveDashScopeFunAsrBrowserDirect(provider);
  return {
    ...resolution,
    enabled,
    active: enabled && resolution.supported,
  };
}

export function assertDashScopeFunAsrDirectAllowed(provider: AsrProvider) {
  const resolution = resolveDashScopeFunAsrBrowserDirect(provider);
  if (!resolution.supported) throw new DailyApiError(422, resolution.message);
  const { endpoint } = resolution;
  if (endpoint.pathname !== DASHSCOPE_FUN_ASR_NATIVE_PATH) {
    throw new DailyApiError(422, "DashScope ASR 直连 endpoint 无效。请关闭该开关后改走 proxy。");
  }
  return endpoint;
}

export function createDashScopeFunAsrDirectBody(
  model: string,
  audio: Uint8Array,
  mimeType: string,
) {
  const cleanMimeType = normalizeMimeType(mimeType);
  return {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [{ audio: toAudioDataUrl(audio, cleanMimeType) }],
        },
      ],
    },
    parameters: { format: audioFormat(cleanMimeType) },
    resources: [],
  };
}

export function parseDashScopeFunAsrDirectTranscript(value: unknown) {
  const record = asRecord(value);
  const output = asRecord(record?.["output"]);
  const sentence = asRecord(output?.["sentence"]);
  const text =
    typeof output?.["text"] === "string"
      ? output["text"]
      : typeof sentence?.["text"] === "string"
        ? sentence["text"]
        : undefined;
  if (typeof text !== "string") {
    throw new DailyApiError(502, "DashScope ASR 直连返回格式不兼容。请关闭该开关后改走 proxy。");
  }
  return { transcript: text };
}

export function createDashScopeFunAsrProbeAudio() {
  return base64ToBytes(FUN_ASR_PROBE_MP3_BASE64);
}

export async function checkDashScopeFunAsrDirectProvider(
  provider: AsrProvider,
  signal?: AbortSignal,
) {
  const endpoint = assertDashScopeFunAsrDirectAllowed(provider);
  await requestDashScopeFunAsr(
    endpoint,
    provider,
    createDashScopeFunAsrProbeAudio(),
    "audio/mpeg",
    signal,
  );
}

export async function transcribeWithDashScopeFunAsrDirect(
  provider: AsrProvider,
  audio: Blob,
  mimeType: string,
  signal?: AbortSignal,
) {
  if (!FUN_ASR_HTTP_AUDIO_MIME_TYPES.has(normalizeMimeType(mimeType))) {
    throw new DailyApiError(
      422,
      "Fun-ASR-Realtime HTTP 接口仅支持 WAV、MP3 或 Opus 音频；当前录音无法转换为兼容格式，请关闭浏览器直连 ASR 后改走 proxy，或更换录音格式。",
    );
  }
  const endpoint = assertDashScopeFunAsrDirectAllowed(provider);
  const payload = await requestDashScopeFunAsr(
    endpoint,
    provider,
    new Uint8Array(await audio.arrayBuffer()),
    mimeType,
    signal,
  );
  return parseDashScopeFunAsrDirectTranscript(payload);
}

async function requestDashScopeFunAsr(
  endpoint: URL,
  provider: AsrProvider,
  audio: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
) {
  const response = await fetchDashScopeFunAsr(endpoint, provider, audio, mimeType, signal);
  if (!response.ok) {
    throw new DailyApiError(response.status, directHttpErrorMessage(response.status));
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (payload === null) {
    throw new DailyApiError(
      response.status,
      "DashScope ASR 直连返回了无效 JSON。请关闭该开关后改走 proxy。",
    );
  }
  return payload;
}

async function fetchDashScopeFunAsr(
  endpoint: URL,
  provider: AsrProvider,
  audio: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
) {
  const body = JSON.stringify(createDashScopeFunAsrDirectBody(provider.model, audio, mimeType));
  try {
    return await fetch(endpoint.toString(), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        "x-dashscope-sse": "disable",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted || isDailyStoryAbortError(error)) throw new DailyApiAbortedError();
    throw new DailyApiError(
      0,
      "当前公共 DashScope endpoint 支持浏览器直连；这次失败更像是本地网络、浏览器策略或临时跨域异常。请检查网络/浏览器拦截，或手动关闭浏览器直连 ASR 后改走 proxy。",
    );
  }
}

function directHttpErrorMessage(status: number) {
  if (status === 401 || status === 403) {
    return "DashScope ASR 直连认证失败。请检查 API Key；若仍失败，请手动关闭浏览器直连 ASR 后改走 proxy。";
  }
  if (status === 408 || status === 504) {
    return "DashScope ASR 直连超时。请重试，或手动关闭浏览器直连 ASR 后改走 proxy。";
  }
  if (status === 429) {
    return "DashScope ASR 直连触发限流。请稍后重试，或手动关闭浏览器直连 ASR 后改走 proxy。";
  }
  if (status >= 400 && status < 500) {
    return "DashScope ASR 直连请求未被接受。请确认仅使用公共 DashScope HTTPS endpoint 与 Fun-ASR HTTP model；若仍失败，请手动关闭浏览器直连 ASR 后改走 proxy。";
  }
  if (status >= 500) {
    return "DashScope ASR 直连暂时不可用。请稍后重试，或手动关闭浏览器直连 ASR 后改走 proxy。";
  }
  return "DashScope ASR 直连失败。请手动关闭浏览器直连 ASR 后改走 proxy。";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeMimeType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "audio/wav";
}

function audioFormat(mimeType: string) {
  return (
    {
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/opus": "opus",
    }[mimeType] ?? "wav"
  );
}

function toAudioDataUrl(audio: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${bytesToBase64(audio)}`;
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < value.length; index += chunk) {
    const slice = value.subarray(index, index + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
