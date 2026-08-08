import { describe, expect, test } from "bun:test";
import { resetDailyStoryRequestGuardsForTests, withDailyStoryRequestGuard } from "./request-guards";

describe("Daily Story request guards", () => {
  test("rate limits by learner and IP per capability", async () => {
    resetDailyStoryRequestGuardsForTests();
    const input = {
      learnerId: "learner",
      ip: "198.51.100.50",
      capability: "chat",
      perMinute: 1,
      concurrent: 1,
      run: async () => "ok",
    };
    await expect(withDailyStoryRequestGuard(input)).resolves.toBe("ok");
    await expect(withDailyStoryRequestGuard(input)).rejects.toMatchObject({ code: "rate_limited" });
  });

  test("rejects duplicate concurrent request before provider work", async () => {
    resetDailyStoryRequestGuardsForTests();
    let release: (() => void) | undefined;
    const running = withDailyStoryRequestGuard({
      learnerId: "learner",
      capability: "asr",
      perMinute: 10,
      concurrent: 1,
      run: () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    });
    await Promise.resolve();
    await expect(
      withDailyStoryRequestGuard({
        learnerId: "learner",
        capability: "asr",
        perMinute: 10,
        concurrent: 1,
        run: async () => "second",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    release?.();
    await expect(running).resolves.toBe("done");
  });

  test("bounds unseen learner bucket growth during a rate-limit window", async () => {
    resetDailyStoryRequestGuardsForTests();
    for (let index = 0; index < 10_000; index += 1) {
      await expect(
        withDailyStoryRequestGuard({
          learnerId: `learner-${index}`,
          capability: "chat",
          perMinute: 1,
          concurrent: 1,
          run: async () => "ok",
        }),
      ).resolves.toBe("ok");
    }
    await expect(
      withDailyStoryRequestGuard({
        learnerId: "learner-over-capacity",
        capability: "chat",
        perMinute: 1,
        concurrent: 1,
        run: async () => "should-not-run",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
