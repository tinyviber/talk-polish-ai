import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createS3AudioStorage } from "./s3-storage";

const minioTest = process.env.RUN_MINIO === "1" ? test : test.skip;
let fixtureServer: ReturnType<typeof Bun.serve>;
let fixtureMode: "missing" | "auth" | "timeout" = "missing";
let fixtureUrl = "";

beforeAll(() => {
  fixtureServer = Bun.serve({
    port: 0,
    fetch: () => {
      if (fixtureMode === "timeout") {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("slow")), 500);
        });
      }
      if (fixtureMode === "auth") return new Response("denied", { status: 403 });
      return new Response("missing", { status: 404 });
    },
  });
  fixtureUrl = fixtureServer.url.origin;
});

afterAll(() => fixtureServer.stop(true));

function fixtureStorage(timeoutMs = 500) {
  return createS3AudioStorage({
    endpoint: fixtureUrl,
    region: "us-east-1",
    bucket: "fixture",
    accessKeyId: "fixture-access",
    secretAccessKey: "fixture-secret",
    forcePathStyle: true,
    requestTimeoutMs: timeoutMs,
    maxAttempts: 1,
    keyPrefix: "",
    maxObjectBytes: 25 * 1024 * 1024,
  });
}

describe("S3-compatible audio storage", () => {
  test("returns null only for a not-found object", async () => {
    fixtureMode = "missing";
    await expect(fixtureStorage().get("s3://fixture/missing.webm")).resolves.toBeNull();
  });

  test("preserves auth failures as StorageError", async () => {
    fixtureMode = "auth";
    await expect(fixtureStorage().get("s3://fixture/secret.webm")).rejects.toMatchObject({
      code: "auth",
    });
  });

  test("preserves timeout failures as StorageError", async () => {
    fixtureMode = "timeout";
    await expect(fixtureStorage(50).get("s3://fixture/slow.webm")).rejects.toMatchObject({
      code: "timeout",
    });
  });

  test("rejects unsafe canonical keys", async () => {
    await expect(fixtureStorage().get("s3://fixture/a//b.webm")).rejects.toMatchObject({
      code: "invalid_key",
    });
  });

  test("normalizes configured key prefixes", async () => {
    const storage = createS3AudioStorage({
      endpoint: fixtureUrl,
      region: "us-east-1",
      bucket: "fixture",
      accessKeyId: "fixture-access",
      secretAccessKey: "fixture-secret",
      forcePathStyle: true,
      requestTimeoutMs: 500,
      maxAttempts: 1,
      keyPrefix: "/tests/",
    });
    expect(storage.keyFor?.("recordings/a.webm")).toBe("s3://fixture/tests/recordings/a.webm");
  });

  minioTest("uploads, downloads, and deletes an object", async () => {
    const storage = createS3AudioStorage({
      endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET ?? "kotoba-audio",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
      forcePathStyle: true,
      requestTimeoutMs: 5_000,
      maxAttempts: 2,
      keyPrefix: "tests/",
      maxObjectBytes: 25 * 1024 * 1024,
    });
    await storage.check?.();
    const key = `recordings/${crypto.randomUUID()}.webm`;
    const stored = await storage.put({
      key,
      body: Buffer.from("minio"),
      contentType: "audio/webm",
    });
    expect(await storage.get(stored.storageKey)).toEqual(Buffer.from("minio"));
    await storage.remove(stored.storageKey);
    expect(await storage.get(stored.storageKey)).toBeNull();
  });
});
