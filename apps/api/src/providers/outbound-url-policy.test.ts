import { describe, expect, test } from "bun:test";
import {
  assertDailyProviderUrlAllowed,
  isPublicInternetAddress,
  joinDailyProviderPath,
  parseDailyProviderBaseUrl,
  resolveDailyProviderPublicAddresses,
} from "./outbound-url-policy";

describe("Daily Story outbound URL policy", () => {
  test("only accepts canonical HTTPS DNS provider URLs", () => {
    const target = parseDailyProviderBaseUrl("https://API.Example.com./v1");
    expect(target.origin).toBe("https://api.example.com");
    expect(target.basePath).toBe("/v1/");
    for (const value of [
      "http://api.example.com",
      "https://user:key@api.example.com",
      "https://api.example.com?key=x",
      "https://api.example.com:444",
      "https://127.0.0.1",
      "https://2130706433",
      "https://localhost",
      "https://provider.local",
    ]) {
      expect(() => parseDailyProviderBaseUrl(value)).toThrow();
    }
  });

  test("does not allow URL joins to escape configured base path", () => {
    const target = parseDailyProviderBaseUrl("https://api.example.com/v1");
    expect(joinDailyProviderPath(target, "/chat/completions").pathname).toBe(
      "/v1/chat/completions",
    );
    expect(() => joinDailyProviderPath(target, "/../metadata")).toThrow();
  });

  test("production accepts only finite server-owned origins", () => {
    const input = "https://api.example.com/v1";
    expect(() =>
      assertDailyProviderUrlAllowed(input, {
        production: true,
        allowedOrigins: [],
      }),
    ).toThrow();
    expect(
      assertDailyProviderUrlAllowed(input, {
        production: true,
        allowedOrigins: ["https://api.example.com"],
      }).origin,
    ).toBe("https://api.example.com");
  });

  test("rejects private, documentation, multicast, and mixed DNS answers", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicInternetAddress(address)).toBe(false);
    }
    await expect(
      resolveDailyProviderPublicAddresses("api.example.com", {
        resolve4: async () => ["8.8.8.8", "127.0.0.1"],
        resolve6: async () => [],
      }),
    ).rejects.toThrow();
    await expect(
      resolveDailyProviderPublicAddresses("api.example.com", {
        resolve4: async () => ["8.8.8.8"],
        resolve6: async () => ["2606:4700:4700::1111"],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      resolveDailyProviderPublicAddresses(
        "api.example.com",
        {
          resolve4: async () => ["198.18.0.98"],
          resolve6: async () => [],
        },
        true,
      ),
    ).resolves.toHaveLength(1);
  });
});
