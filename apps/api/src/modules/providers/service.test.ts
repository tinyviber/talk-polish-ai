import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderCapability, ProviderDiagnostics, SynthesisRequest } from "@kotoba/contracts";
import { env, resetEnvForTests, type Env } from "../../env";
import type { Providers } from "../../providers";
import { withSynthesisStorageDisposition } from "../../providers/tts";
import { createProviderApplication } from "./service";

const capability = (
  provider: string,
  status: ProviderCapability["status"],
): ProviderCapability => ({
  provider,
  status,
  checkedAt: "2026-08-04T00:00:00.000Z",
});

function diagnostics(requestId: string): ProviderDiagnostics {
  return {
    requestId,
    database: capability("postgresql", "available"),
    storage: capability("local", "available"),
    chat: capability("mock-chat", "available"),
    transcription: capability("mock-transcription", "available"),
    tts: capability("mock-tts", "available"),
    realtime: capability("mock-realtime", "unsupported"),
  };
}

function config(overrides: Partial<Env> = {}): Env {
  return { ...env(), ...overrides };
}

function synthesisRequest(): SynthesisRequest {
  return { text: "Hello there", lang: "en" };
}

function providerSet(
  synthesize: Providers["tts"]["synthesize"] = async () => ({
    storageKey: null,
    seconds: 1,
    provider: "mock-tts",
  }),
): Providers {
  return {
    assessment: {
      name: "mock-assessment",
      assess: async () => {
        throw new Error("not used in provider service tests");
      },
    },
    transcription: {
      name: "mock-transcription",
      transcribe: async () => {
        throw new Error("not used in provider service tests");
      },
    },
    tts: { name: "mock-tts", synthesize },
    storage: {
      name: "local",
      async put() {
        throw new Error("not used in provider service tests");
      },
      async get() {
        return null;
      },
      async remove() {},
    },
    realtime: {
      name: "mock-realtime",
      configured: false,
      checkConfiguration() {},
      async smokeTest() {},
    },
  };
}

afterEach(() => {
  resetEnvForTests();
});

describe("provider application", () => {
  test("only rate limits diagnostics when active probe is both enabled and requested", async () => {
    const rateLimitCalls: Array<{ learnerId: string; capability: string; ip?: string }> = [];
    const activeProbeFlags: boolean[] = [];
    const diagnoseProviders = async (requestId: string, activeProbe = false) => {
      activeProbeFlags.push(activeProbe);
      return diagnostics(requestId);
    };

    const passiveService = createProviderApplication(
      config({ DIAGNOSTICS_ACTIVE_PROBE: false }),
      providerSet(),
      {
        diagnoseProviders,
        enforceProviderRateLimit(learnerId, capability, ip) {
          rateLimitCalls.push({ learnerId, capability, ip });
        },
      },
    );
    await passiveService.diagnose("learner-passive", "req-passive", "203.0.113.10", true);

    const activeService = createProviderApplication(
      config({ DIAGNOSTICS_ACTIVE_PROBE: true }),
      providerSet(),
      {
        diagnoseProviders,
        enforceProviderRateLimit(learnerId, capability, ip) {
          rateLimitCalls.push({ learnerId, capability, ip });
        },
      },
    );
    await activeService.diagnose("learner-active", "req-no-probe", "203.0.113.11", false);
    await activeService.diagnose("learner-active", "req-probe", "203.0.113.11", true);

    expect(activeProbeFlags).toEqual([false, false, true]);
    expect(rateLimitCalls).toEqual([
      { learnerId: "learner-active", capability: "diagnostics", ip: "203.0.113.11" },
    ]);
  });

  test("does not delete a cached TTS object when reference persistence fails", async () => {
    const cleanupCalls: string[] = [];
    const service = createProviderApplication(
      config(),
      providerSet(async () =>
        withSynthesisStorageDisposition(
          {
            storageKey: "local://tts/learner/expression/hash.mp3",
            contentType: "audio/mpeg",
            seconds: 1,
            provider: "openai-compatible-tts",
          },
          "cache-hit",
        ),
      ),
      {
        issueAudioReference: async () => {
          throw new Error("reference insert failed");
        },
        removeOrQueueStorage: async (_storage, storageKey) => {
          cleanupCalls.push(storageKey);
        },
        providerRepository: {
          async findRecordingForLearner() {
            return undefined;
          },
        },
      },
    );

    await expect(
      service.synthesize("learner-1", synthesisRequest(), "req-cache-hit", "198.51.100.4"),
    ).rejects.toMatchObject({ code: "processing_unavailable" });

    expect(cleanupCalls).toEqual([]);
  });

  test("defers cleanup for a newly created TTS object when reference persistence fails", async () => {
    const cleanupCalls: Array<{ storageKey: string; notBefore?: Date }> = [];
    const service = createProviderApplication(
      config(),
      providerSet(async () =>
        withSynthesisStorageDisposition(
          {
            storageKey: "local://tts/learner/expression/hash.mp3",
            contentType: "audio/mpeg",
            seconds: 1,
            provider: "openai-compatible-tts",
          },
          "created",
        ),
      ),
      {
        issueAudioReference: async () => {
          throw new Error("reference insert failed");
        },
        removeOrQueueStorage: async (_storage, storageKey, _reason, notBefore) => {
          cleanupCalls.push({ storageKey, notBefore });
        },
        providerRepository: {
          async findRecordingForLearner() {
            return undefined;
          },
        },
      },
    );

    await expect(
      service.synthesize("learner-2", synthesisRequest(), "req-shared", "198.51.100.5"),
    ).rejects.toMatchObject({ code: "processing_unavailable" });

    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]?.storageKey).toBe("local://tts/learner/expression/hash.mp3");
    expect(cleanupCalls[0]?.notBefore?.getTime()).toBeGreaterThan(Date.now());
  });
});
