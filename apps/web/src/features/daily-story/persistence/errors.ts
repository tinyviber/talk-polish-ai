export class DailyStorageError extends Error {
  constructor(message = "当前浏览器无法访问本机存储。请允许此网站使用 IndexedDB 后重试。") {
    super(message);
    this.name = "DailyStorageError";
  }
}

export class SessionConflictError extends Error {
  constructor() {
    super("此对话已在另一标签页更新。已载入最新内容。");
    this.name = "SessionConflictError";
  }
}

/** The primary session store committed; the review sidecar still needs cleanup/retry. */
export class StorySidecarPersistenceError extends DailyStorageError {
  readonly committed = true;

  constructor(
    readonly conversationId: string,
    readonly operation: "write" | "delete",
  ) {
    super(`故事已${operation === "write" ? "保存" : "删除"}，但复核缓存清理失败。请重试。`);
    this.name = "StorySidecarPersistenceError";
  }
}

export class StoryImportError extends Error {
  constructor(message = "导入文件无效，未修改现有对话。") {
    super(message);
    this.name = "StoryImportError";
  }
}

export const RECOVERABLE_DATABASE_ERROR_NAMES = new Set([
  "AbortError",
  "InvalidStateError",
  "TransactionInactiveError",
  "TransactionClosedError",
  "DatabaseClosedError",
]);

function errorName(error: unknown) {
  return error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
}

export function isRecoverableDatabaseError(error: unknown) {
  return (
    typeof errorName(error) === "string" &&
    RECOVERABLE_DATABASE_ERROR_NAMES.has(errorName(error) as string)
  );
}

export function normalizeStorageError(error: unknown) {
  if (
    error instanceof DailyStorageError ||
    error instanceof SessionConflictError ||
    error instanceof StoryImportError
  )
    return error;
  return new DailyStorageError();
}
