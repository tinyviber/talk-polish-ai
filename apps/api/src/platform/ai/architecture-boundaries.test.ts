import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { SpeechToText as LegacySpeechToText } from "../../providers/index";
import type { TextModel as LegacyTextModel } from "../../providers/index";
import type { TextToSpeech as LegacyTextToSpeech } from "../../providers/index";
import type { SpeechToText } from "./capabilities/speech-to-text";
import type { TextModel } from "./capabilities/text-model";
import type { TextToSpeech } from "./capabilities/text-to-speech";
import * as legacyTransport from "../../providers/safe-https-client";
import * as legacyUrlPolicy from "../../providers/outbound-url-policy";
import * as legacyDiagnostics from "../../providers/diagnostics";
import * as platformTransport from "./transport";

const root = new URL(".", import.meta.url);

async function source(path: string) {
  const value = await readFile(new URL(path, root), "utf8");
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("AI platform boundaries", () => {
  test("capability ports reuse the existing source-of-truth types", async () => {
    const [text, speech, tts] = await Promise.all([
      source("capabilities/text-model.ts"),
      source("capabilities/speech-to-text.ts"),
      source("capabilities/text-to-speech.ts"),
    ]);

    expect(text).toMatch(/from "\.\.\/\.\.\/\.\.\/capabilities\/text-model"/);
    expect(speech).toMatch(/from "\.\.\/\.\.\/\.\.\/capabilities\/speech-to-text"/);
    expect(tts).toMatch(/from "\.\.\/\.\.\/\.\.\/capabilities\/text-to-speech"/);
    expect(text).not.toMatch(/(?:interface|type)\s+TextModel\s*[={]/);
    expect(speech).not.toMatch(/(?:interface|type)\s+SpeechToText\s*[={]/);
    expect(tts).not.toMatch(/(?:interface|type)\s+TextToSpeech\s*[={]/);
  });

  test("legacy providers imports and platform ports are assignable", () => {
    const text: TextModel = {} as LegacyTextModel;
    const speech: SpeechToText = {} as LegacySpeechToText;
    const tts: TextToSpeech = {} as LegacyTextToSpeech;
    const legacyText: LegacyTextModel = text;
    const legacySpeech: LegacySpeechToText = speech;
    const legacyTts: LegacyTextToSpeech = tts;

    void [legacyText, legacySpeech, legacyTts];
    expect(true).toBe(true);
  });

  test("registry centralizes ordered selection", async () => {
    const registry = await source("registry/provider-registry.ts");

    expect(registry).toMatch(/\.find\(/);
    expect(registry).not.toMatch(/if\s*\([^)]*capability/);
    expect(registry).not.toMatch(/else\s+if/);
  });

  test("AI composition roots delegate capability creation to the registry", async () => {
    const [providers, requestScoped] = await Promise.all([
      source("../../providers/index.ts"),
      source("../../providers/request-scoped.ts"),
    ]);

    expect(providers).toMatch(/createProviderRegistry/);
    expect(providers).toMatch(/createTextModel/);
    expect(providers).toMatch(/createSpeechToText/);
    expect(providers).toMatch(/createTextToSpeech/);
    expect(providers.indexOf("createProviderRegistry")).toBeLessThan(
      providers.indexOf("const textModel"),
    );
    expect(requestScoped).toMatch(/createProbedProviderRegistry/);
    expect(requestScoped).toMatch(/createTextModel/);
    expect(requestScoped).toMatch(/createSpeechToText/);
    expect(requestScoped).toMatch(/createTextToSpeech/);
  });

  test("transport facade only re-exports existing security and diagnostics modules", async () => {
    const transport = await source("transport/index.ts");

    expect(transport).toMatch(/providers\/safe-https-client/);
    expect(transport).toMatch(/providers\/outbound-url-policy/);
    expect(transport).toMatch(/providers\/diagnostics/);
    expect(transport).not.toMatch(/httpsRequest|resolve4|resolve6|new URL/);
    expect(platformTransport.DailyProviderRequestError).toBe(
      legacyTransport.DailyProviderRequestError,
    );
    expect(platformTransport.createDailySafeHttpsClient).toBe(
      legacyTransport.createDailySafeHttpsClient,
    );
    expect(platformTransport.DailyProviderConfigurationError).toBe(
      legacyUrlPolicy.DailyProviderConfigurationError,
    );
    expect(platformTransport.DailyProviderDnsError).toBe(legacyUrlPolicy.DailyProviderDnsError);
    expect(platformTransport.assertDailyProviderUrlAllowed).toBe(
      legacyUrlPolicy.assertDailyProviderUrlAllowed,
    );
    expect(platformTransport.isPublicInternetAddress).toBe(legacyUrlPolicy.isPublicInternetAddress);
    expect(platformTransport.joinDailyProviderPath).toBe(legacyUrlPolicy.joinDailyProviderPath);
    expect(platformTransport.parseDailyProviderBaseUrl).toBe(
      legacyUrlPolicy.parseDailyProviderBaseUrl,
    );
    expect(platformTransport.resolveDailyProviderPublicAddresses).toBe(
      legacyUrlPolicy.resolveDailyProviderPublicAddresses,
    );
    expect(platformTransport.diagnoseProviders).toBe(legacyDiagnostics.diagnoseProviders);
  });
});
