import { describe, expect, test } from "bun:test";
import type { SpeechToText } from "../capabilities/speech-to-text";
import type { TextModel } from "../capabilities/text-model";
import type { TextToSpeech } from "../capabilities/text-to-speech";
import {
  createProviderRegistry,
  type ProviderAdapterRegistry,
  ProviderSelectionError,
} from "./provider-registry";

type TestConfig = { kind: "specific" | "fallback" };

const textModel: TextModel = {
  name: "test-text-model",
  async generate() {
    return { content: "", provider: "test" };
  },
};

const speechToText: SpeechToText = {
  name: "test-speech-to-text",
  async transcribe() {
    return { text: "", provider: "test" };
  },
};

const textToSpeech: TextToSpeech = {
  name: "test-text-to-speech",
  async synthesize() {
    return { bytes: new Uint8Array(), contentType: "audio/mpeg", provider: "test" };
  },
};

function registryFor(configured: boolean) {
  const adapters: ProviderAdapterRegistry<TestConfig, TestConfig, TestConfig> = {
    textModel: [
      {
        name: "specific-text-model",
        matches: (config) => config.kind === "specific",
        create: () => textModel,
      },
      {
        name: "fallback-text-model",
        matches: () => configured,
        create: () => textModel,
      },
    ],
    speechToText: [{ name: "speech-to-text", matches: () => true, create: () => speechToText }],
    textToSpeech: [{ name: "text-to-speech", matches: () => true, create: () => textToSpeech }],
  };
  return createProviderRegistry(adapters);
}

describe("provider registry", () => {
  test("selects the first matching adapter and keeps fallback order explicit", () => {
    const registry = registryFor(true);

    expect(registry.createTextModel({ kind: "specific" })).toBe(textModel);
    expect(registry.createTextModel({ kind: "fallback" })).toBe(textModel);
    expect(registry.createSpeechToText({ kind: "fallback" })).toBe(speechToText);
    expect(registry.createTextToSpeech({ kind: "fallback" })).toBe(textToSpeech);
  });

  test("fails closed when a capability has no matching adapter", () => {
    expect(() => registryFor(false).createTextModel({ kind: "fallback" })).toThrow(
      ProviderSelectionError,
    );
  });
});
