import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifySyncToken } from "../../auth";

describe("personal sync token", () => {
  test("uses SHA-256 digest and timing-safe verification", () => {
    const token = "local-sync-token-with-enough-entropy";
    const digest = createHash("sha256").update(token).digest("hex");

    expect(() => verifySyncToken(token, digest)).not.toThrow();
    expect(() => verifySyncToken("wrong-token", digest)).toThrow();
    expect(() => verifySyncToken(token, undefined)).toThrow();
  });
});
