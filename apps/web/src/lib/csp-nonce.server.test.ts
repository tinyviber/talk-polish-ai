import { describe, expect, test } from "vitest";
import { cspHeader } from "./csp-nonce.server";

describe("web CSP", () => {
  test("keeps connect-src narrow while allowing only fixed DashScope direct ASR origins", () => {
    const header = cspHeader("nonce-value");
    const connectSrc =
      header.split("; ").find((directive) => directive.startsWith("connect-src ")) ?? "";

    expect(connectSrc).toBe(
      "connect-src 'self' https://dashscope.aliyuncs.com https://dashscope-intl.aliyuncs.com",
    );
    expect(connectSrc).not.toContain(" https: ");
    expect(connectSrc).not.toContain("maas.aliyuncs.com");
    expect(header).not.toContain("wss:");
  });
});
