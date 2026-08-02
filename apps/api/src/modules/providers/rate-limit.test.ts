import { describe, expect, test } from "bun:test";
import { enforceProviderRateLimit, resetProviderRateLimitsForTests } from "./rate-limit";

describe("provider rate limit", () => {
  test("bounds repeated capability calls per learner", () => {
    resetProviderRateLimitsForTests();
    const limit = Number(process.env.PROVIDER_RATE_LIMIT_PER_MINUTE ?? 20);
    for (let i = 0; i < limit; i += 1) enforceProviderRateLimit("learner-test", "tts");
    expect(() => enforceProviderRateLimit("learner-test", "tts")).toThrow("rate limited");
    resetProviderRateLimitsForTests();
    for (let i = 0; i < limit; i += 1) enforceProviderRateLimit(`learner-${i}`, "tts", "127.0.0.1");
    expect(() => enforceProviderRateLimit("another-learner", "tts", "127.0.0.1")).toThrow(
      "rate limited",
    );
    resetProviderRateLimitsForTests();
  });
});
