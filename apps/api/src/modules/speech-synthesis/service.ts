import type { Lang } from "@kotoba/contracts";
import type { TextToSpeech } from "../../capabilities/text-to-speech";
import { getSynthesisStorageDisposition, type SynthesisResult } from "../../providers/tts";
import type { AudioStorageProvider } from "../../providers/storage";
import { readCachedAudio, writeCachedAudio } from "./cache-policy";
import { synthesisObjectKey } from "./key-policy";

export type SpeechSynthesisDependencies = {
  textToSpeech: TextToSpeech;
  storage: AudioStorageProvider;
  model: string;
  defaultVoice: string;
};

/** Application-owned TTS cache/storage orchestration. */
export function createSpeechSynthesisService(deps: SpeechSynthesisDependencies) {
  const inFlight = new Map<string, Promise<SynthesisResult>>();
  return {
    name: deps.textToSpeech.name,
    check: deps.textToSpeech.check,
    probe: deps.textToSpeech.probe,
    async synthesize(input: {
      text: string;
      lang: Lang;
      voice?: string;
      purpose?: "prompt" | "answer" | "expression";
      scope?: string;
    }): Promise<SynthesisResult> {
      const voice = input.voice ?? deps.defaultVoice;
      const purpose = input.purpose ?? "expression";
      const scope = input.scope ?? "public";
      const format = "mp3";
      const key = synthesisObjectKey({
        scope,
        purpose,
        model: deps.model,
        voice,
        lang: input.lang,
        format,
        text: input.text,
      });
      const cached = await readCachedAudio(deps.storage, key);
      if (cached) {
        return {
          storageKey: deps.storage.keyFor?.(key) ?? key,
          cacheStatus: "cache-hit",
          contentType: "audio/mpeg",
          seconds: Math.max(1, Math.round(input.text.length / 14)),
          provider: deps.textToSpeech.name,
        };
      }
      const current = inFlight.get(key);
      if (current) return current;
      const work = (async () => {
        const audio = await deps.textToSpeech.synthesize({
          text: input.text,
          voice,
          locale: input.lang === "ja" ? "ja-JP" : "en-US",
          format,
        });
        const stored = await writeCachedAudio(deps.storage, key, audio.bytes, audio.contentType);
        return {
          storageKey: stored.storageKey,
          cacheStatus: "created" as const,
          contentType: audio.contentType,
          seconds: audio.durationSec ?? Math.max(1, Math.round(input.text.length / 14)),
          provider: audio.provider,
        };
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, work);
      return work;
    },
  };
}

export { getSynthesisStorageDisposition };
