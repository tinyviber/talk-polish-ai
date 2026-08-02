import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ProviderConfigurationError } from "./http";
import {
  StorageError,
  validateStoragePathKey,
  type AudioStorageProvider,
  type PutAudioInput,
} from "./storage";

export type S3StorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  requestTimeoutMs: number;
  maxAttempts: number;
  keyPrefix: string;
  maxObjectBytes?: number;
};

const PREFIX = "s3://";

export function createS3AudioStorage(config: S3StorageConfig): AudioStorageProvider {
  const configured = Boolean(
    config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey,
  );
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: config.maxAttempts,
    ...(configured
      ? {
          credentials: {
            accessKeyId: config.accessKeyId!,
            secretAccessKey: config.secretAccessKey!,
          },
        }
      : {}),
  });

  const keyPrefix = normalizePrefix(config.keyPrefix);

  const normalizeKey = (key: string) => {
    return validateStoragePathKey(`${keyPrefix}${key}`);
  };

  const requireConfigured = () => {
    if (!configured) throw new ProviderConfigurationError("S3 storage credentials are incomplete");
  };

  async function send(command: unknown) {
    requireConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await client.send(command as never, { abortSignal: controller.signal });
    } catch (error) {
      const status = getHttpStatus(error);
      if (controller.signal.aborted) {
        throw new StorageError("S3 request timed out", { code: "timeout", status, cause: error });
      }
      throw new StorageError("S3 request failed", {
        code: classifyS3Error(error, status),
        status,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function parseStorageKey(storageKey: string) {
    if (!storageKey.startsWith(`${PREFIX}${config.bucket}/`)) {
      throw new StorageError("invalid storage key", { code: "invalid_key" });
    }
    const key = storageKey.slice(`${PREFIX}${config.bucket}/`.length);
    return validateStoragePathKey(key);
  }

  return {
    name: "s3",
    keyFor: (key: string) => `${PREFIX}${config.bucket}/${normalizeKey(key)}`,
    async check() {
      requireConfigured();
    },
    async probe() {
      await send(new HeadBucketCommand({ Bucket: config.bucket }));
    },
    async put({ key, body, contentType }: PutAudioInput) {
      const objectKey = normalizeKey(key);
      await send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { storageKey: `${PREFIX}${config.bucket}/${objectKey}` };
    },
    async get(storageKey: string) {
      const key = parseStorageKey(storageKey);
      if (!key) return null;
      try {
        const response = (await send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        )) as {
          ContentLength?: number;
          Body?: {
            transformToByteArray?: () => Promise<Uint8Array>;
          } & AsyncIterable<Uint8Array>;
        };
        if (
          typeof response.ContentLength === "number" &&
          response.ContentLength > (config.maxObjectBytes ?? 25 * 1024 * 1024)
        ) {
          throw new StorageError("S3 object is too large", { code: "io" });
        }
        if (!response.Body) {
          throw new StorageError("S3 response had no object body", { code: "io" });
        }
        return readS3Body(
          response.Body,
          config.maxObjectBytes ?? 25 * 1024 * 1024,
          config.requestTimeoutMs,
        );
      } catch (error) {
        if (error instanceof StorageError && error.code === "not_found") return null;
        throw error;
      }
    },
    async remove(storageKey: string) {
      const key = parseStorageKey(storageKey);
      await send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

async function readS3Body(
  body: {
    transformToByteArray?: () => Promise<Uint8Array>;
  } & AsyncIterable<Uint8Array>,
  maxBytes: number,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void body[Symbol.asyncIterator]().return?.();
      reject(new StorageError("S3 body read timed out", { code: "timeout" }));
    }, timeoutMs);
  });
  const read = (async () => {
    if (typeof body.transformToByteArray === "function") {
      const bytes = await body.transformToByteArray();
      if (bytes.byteLength > maxBytes)
        throw new StorageError("S3 object is too large", { code: "io" });
      return Buffer.from(bytes);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new StorageError("S3 object is too large", { code: "io" });
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizePrefix(prefix: string) {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${validateStoragePathKey(trimmed)}/` : "";
}

function getHttpStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  if ("$metadata" in error && error.$metadata && typeof error.$metadata === "object") {
    const metadata = error.$metadata as { httpStatusCode?: unknown };
    return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
  }
  return undefined;
}

function classifyS3Error(error: unknown, status: number | undefined) {
  const name = getErrorName(error);
  if (status === 404 || name === "NoSuchKey" || name === "NotFound") return "not_found" as const;
  if (
    status === 401 ||
    status === 403 ||
    [
      "InvalidAccessKeyId",
      "AccessDenied",
      "SignatureDoesNotMatch",
      "InvalidToken",
      "ExpiredToken",
    ].includes(name)
  ) {
    return "auth" as const;
  }
  if (
    error instanceof TypeError ||
    [
      "AbortError",
      "TimeoutError",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "SocketError",
      "FetchError",
    ].includes(name)
  ) {
    return "network" as const;
  }
  return "unknown" as const;
}

function getErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  if ("name" in error && typeof error.name === "string") return error.name;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "";
}
