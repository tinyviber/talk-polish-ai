import type { SpeechToText } from "../capabilities/speech-to-text";
import type { TextModel } from "../capabilities/text-model";
import type { TextToSpeech } from "../capabilities/text-to-speech";
import type { ProviderProbe } from "../probe";

/** A provider adapter is selected by capability, then created for one config. */
export type ProviderAdapter<Config, Port> = {
  readonly name: string;
  readonly matches: (config: Config) => boolean;
  readonly create: (config: Config) => Port;
};

export type CapabilityPorts = {
  textModel: TextModel;
  speechToText: SpeechToText;
  textToSpeech: TextToSpeech;
};

/** Capability port set for compositions that promise an active connectivity probe. */
export type ProbedCapabilityPorts = {
  textModel: TextModel & ProviderProbe;
  speechToText: SpeechToText & ProviderProbe;
  textToSpeech: TextToSpeech & ProviderProbe;
};

export type ProviderAdapterRegistry<
  TextConfig,
  SpeechConfig,
  TtsConfig,
  Ports extends CapabilityPorts = CapabilityPorts,
> = {
  readonly textModel: readonly ProviderAdapter<TextConfig, Ports["textModel"]>[];
  readonly speechToText: readonly ProviderAdapter<SpeechConfig, Ports["speechToText"]>[];
  readonly textToSpeech: readonly ProviderAdapter<TtsConfig, Ports["textToSpeech"]>[];
};

export type ProviderRegistry<
  TextConfig,
  SpeechConfig,
  TtsConfig,
  Ports extends CapabilityPorts = CapabilityPorts,
> = {
  readonly createTextModel: (config: TextConfig) => Ports["textModel"];
  readonly createSpeechToText: (config: SpeechConfig) => Ports["speechToText"];
  readonly createTextToSpeech: (config: TtsConfig) => Ports["textToSpeech"];
};

/**
 * Select the first matching adapter in registration order.
 *
 * Registration order is intentional: specific adapters belong before the
 * capability fallback. Keeping this operation generic gives request-scoped
 * providers a single selection seam without moving their secure transport or
 * changing their provider-specific factories.
 */
export function selectProviderAdapter<Config, Port>(
  capability: string,
  adapters: readonly ProviderAdapter<Config, Port>[],
  config: Config,
): Port {
  const adapter = adapters.find((candidate) => candidate.matches(config));
  if (!adapter) throw new ProviderSelectionError(capability);
  return adapter.create(config);
}

export function createProviderRegistry<
  TextConfig,
  SpeechConfig,
  TtsConfig,
  Ports extends CapabilityPorts = CapabilityPorts,
>(
  adapters: ProviderAdapterRegistry<TextConfig, SpeechConfig, TtsConfig, Ports>,
): ProviderRegistry<TextConfig, SpeechConfig, TtsConfig, Ports> {
  return {
    createTextModel: (config) => selectProviderAdapter("textModel", adapters.textModel, config),
    createSpeechToText: (config) =>
      selectProviderAdapter("speechToText", adapters.speechToText, config),
    createTextToSpeech: (config) =>
      selectProviderAdapter("textToSpeech", adapters.textToSpeech, config),
  };
}

/**
 * Registry variant whose adapter factories must implement an active probe.
 * Keep this stricter seam opt-in so other platform capabilities remain probe-free.
 */
export function createProbedProviderRegistry<
  TextConfig,
  SpeechConfig,
  TtsConfig,
  Ports extends ProbedCapabilityPorts = ProbedCapabilityPorts,
>(
  adapters: ProviderAdapterRegistry<TextConfig, SpeechConfig, TtsConfig, Ports>,
): ProviderRegistry<TextConfig, SpeechConfig, TtsConfig, Ports> {
  return createProviderRegistry<TextConfig, SpeechConfig, TtsConfig, Ports>(adapters);
}

export class ProviderSelectionError extends Error {
  readonly code = "provider_selection";

  constructor(readonly capability: string) {
    super(`No provider adapter matched capability: ${capability}`);
  }
}
