import { ApiClientError } from "@/lib/practice/api";

export class DailyApiError extends Error {
  readonly status: number;

  constructor(status: number, message = dailyErrorMessage(status)) {
    super(message);
    this.name = "DailyApiError";
    this.status = status;
  }
}

export class DailyApiAbortedError extends Error {
  constructor() {
    super("Daily Story 请求已取消。");
    this.name = "AbortError";
  }
}

export function isDailyStoryAbortError(error: unknown): error is DailyApiAbortedError {
  return (
    error instanceof DailyApiAbortedError ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

export function dailyApiErrorFromTransport(error: unknown, signal?: AbortSignal) {
  // fetchWithRetry uses status 0 for both caller cancellation and transport
  // failures. Only an already-aborted caller signal is an AbortError; a
  // timeout or ordinary network failure must remain visible as failure.
  if (signal?.aborted || isDailyStoryAbortError(error)) return new DailyApiAbortedError();
  if (error instanceof ApiClientError) return new DailyApiError(error.status);
  return new DailyApiError(0);
}

function dailyErrorMessage(status: number) {
  if (status === 401 || status === 403) return "配置验证失败。请检查对应服务的 API Key。";
  if (status === 429) return "请求过于频繁。请稍后重试。";
  if (status === 408 || status === 504) return "服务响应超时。请重试。";
  if (status >= 400 && status < 500) return "请求无法完成。请检查配置或缩短内容后重试。";
  if (status >= 500) return "服务暂时不可用。请稍后重试。";
  return "无法连接服务。请检查网络后重试。";
}
