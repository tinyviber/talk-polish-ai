import { describe, expect, test } from "bun:test";
import { createSpeechSynthesisService } from "./service";

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    name: "fake-storage",
    objects,
    async put(input: { key: string; body: Buffer }) {
      objects.set(input.key, input.body);
      return { storageKey: input.key };
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async remove(key: string) {
      objects.delete(key);
    },
  };
}

function fakeSpeechToSpeech(storage: ReturnType<typeof fakeStorage>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    name: "fake-tts",
    async synthesize() {
      calls += 1;
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "audio/mpeg",
        durationSec: 2,
        provider: "fake-tts",
      };
    },
    storage,
  };
}

describe("speech synthesis application service", () => {
  test("deduplicates concurrent misses and serves later cache hits", async () => {
    const storage = fakeStorage();
    const provider = fakeSpeechToSpeech(storage);
    const service = createSpeechSynthesisService({
      textToSpeech: provider,
      storage,
      model: "fake-model",
      defaultVoice: "alloy",
    });

    const [first, second] = await Promise.all([
      service.synthesize({ text: "hello", lang: "en", scope: "learner-1" }),
      service.synthesize({ text: "hello", lang: "en", scope: "learner-1" }),
    ]);
    const cached = await service.synthesize({ text: "hello", lang: "en", scope: "learner-1" });

    expect(provider.calls).toBe(1);
    expect(first.cacheStatus).toBe("created");
    expect(second.storageKey).toBe(first.storageKey);
    expect(cached.cacheStatus).toBe("cache-hit");
    expect(cached.storageKey).toBe(first.storageKey);
  });

  test("does not poison in-flight cache after provider failure", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const provider = {
      name: "flaky-tts",
      async synthesize() {
        calls += 1;
        if (calls === 1) throw new Error("provider down");
        return {
          bytes: new Uint8Array([4]),
          contentType: "audio/mpeg",
          provider: "flaky-tts",
        };
      },
    };
    const service = createSpeechSynthesisService({
      textToSpeech: provider,
      storage,
      model: "fake-model",
      defaultVoice: "alloy",
    });

    await expect(service.synthesize({ text: "retry", lang: "en" })).rejects.toThrow(
      "provider down",
    );
    await expect(service.synthesize({ text: "retry", lang: "en" })).resolves.toMatchObject({
      cacheStatus: "created",
    });
    expect(calls).toBe(2);
  });
});
