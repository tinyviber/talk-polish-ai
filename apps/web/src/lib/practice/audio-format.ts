import { DASHSCOPE_FUN_ASR_HTTP_AUDIO_MIME_TYPES } from "@kotoba/contracts";

type DecodedAudio = Pick<
  AudioBuffer,
  "length" | "numberOfChannels" | "sampleRate" | "getChannelData"
>;

type AudioContextConstructor = new () => AudioContext;

export class RecordedAudioFormatError extends Error {
  readonly code = "recorded_audio_format" as const;

  constructor(message = "当前浏览器无法将录音转换为 WAV。请更新 iOS/浏览器后重试。") {
    super(message);
    this.name = "RecordedAudioFormatError";
  }
}

export const MAX_NORMALIZED_AUDIO_BYTES = 25 * 1024 * 1024;
export const TARGET_RECORDING_SAMPLE_RATE = 16_000;

const NORMALIZABLE_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
]);
const FUN_ASR_AUDIO_MIME_TYPES = new Set<string>(DASHSCOPE_FUN_ASR_HTTP_AUDIO_MIME_TYPES);

/** Return whether browser-recorded audio should be decoded and normalized to WAV. */
export function isNormalizableAudioMimeType(mimeType: string) {
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return NORMALIZABLE_AUDIO_MIME_TYPES.has(normalizedMimeType ?? "");
}

function audioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  );
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** Encode decoded browser audio as little-endian PCM WAV for ASR gateways. */
export function encodePcmWav(audio: DecodedAudio) {
  const channels = Math.max(1, Math.min(2, audio.numberOfChannels));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = audio.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const channelData = Array.from({ length: channels }, (_, channel) =>
    audio.getChannelData(channel),
  );
  let offset = 44;
  for (let frame = 0; frame < audio.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel]![frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function chooseNormalizedAudio(
  _original: Blob,
  _mimeType: string,
  decoded: DecodedAudio,
  maxBytes = MAX_NORMALIZED_AUDIO_BYTES,
  strict = true,
) {
  const wav = encodePcmWav(decoded);
  if (wav.size > maxBytes) {
    if (strict) {
      throw new RecordedAudioFormatError("录音转换后的 WAV 超过 25 MiB 限制，请缩短录音后重试。");
    }
    return { blob: _original, mimeType: _mimeType };
  }
  return { blob: wav, mimeType: "audio/wav" };
}

/**
 * WebM, Ogg, MP4, and M4A are valid browser recording formats, but some
 * OpenAI-compatible ASR gateways cannot parse their duration. Normalize them
 * to WAV before upload. Strict callers (Fun-ASR) reject decode failures;
 * ordinary providers retain their original compatible browser recording.
 */
export async function normalizeRecordedAudio(
  blob: Blob,
  maxBytesOrOptions: number | NormalizeRecordedAudioOptions = MAX_NORMALIZED_AUDIO_BYTES,
  maybeOptions: NormalizeRecordedAudioOptions = {},
): Promise<{ blob: Blob; mimeType: string }> {
  const maxBytes =
    typeof maxBytesOrOptions === "number" ? maxBytesOrOptions : MAX_NORMALIZED_AUDIO_BYTES;
  const options = typeof maxBytesOrOptions === "number" ? maybeOptions : maxBytesOrOptions;
  const strict = options.strict ?? options.requireWav ?? false;
  const mimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() || "audio/webm";
  if (strict && !FUN_ASR_AUDIO_MIME_TYPES.has(mimeType)) {
    throw new RecordedAudioFormatError("Fun-ASR 仅支持 WAV 或 MP3 音频。请重新录音后重试。");
  }
  if (!isNormalizableAudioMimeType(mimeType)) {
    return { blob, mimeType };
  }
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) {
    if (strict) throw new RecordedAudioFormatError();
    return { blob, mimeType };
  }

  let context: AudioContext | undefined;
  try {
    context = new AudioContextCtor();
    if (typeof context.resume === "function") await context.resume().catch(() => {});
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    return chooseNormalizedAudio(blob, mimeType, decoded, maxBytes, strict);
  } catch (error) {
    if (error instanceof RecordedAudioFormatError && strict) throw error;
    if (strict) throw new RecordedAudioFormatError();
    return { blob, mimeType };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export type PcmWavCapture = {
  stop: () => Blob | null;
  dispose: () => void;
};

export type NormalizeRecordedAudioOptions = {
  /** Reject compressed browser formats when WAV conversion is unavailable. */
  strict?: boolean;
  /** Alias for strict mode, kept explicit for provider call sites. */
  requireWav?: boolean;
};

/**
 * Capture microphone PCM through Web Audio while MediaRecorder runs.
 * ScriptProcessor is deprecated, but remains the smallest Safari-compatible
 * fallback when iOS cannot decode its own MP4 recording afterward.
 */
export function createPcmWavCapture(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
): PcmWavCapture | null {
  if (typeof context.createScriptProcessor !== "function") return null;
  let processor: ScriptProcessorNode;
  let silentGain: GainNode;
  try {
    processor = context.createScriptProcessor(4096, 1, 1);
    silentGain = context.createGain();
  } catch {
    return null;
  }
  const chunks: Float32Array[] = [];
  let active = true;
  const disconnect = () => {
    if (!active) return;
    active = false;
    processor.onaudioprocess = null;
    try {
      source.disconnect(processor);
    } catch {
      // Already disconnected by browser lifecycle.
    }
    try {
      processor.disconnect();
      silentGain.disconnect();
    } catch {
      // Already disconnected by browser lifecycle.
    }
  };
  processor.onaudioprocess = (event) => {
    if (!active) return;
    const input = event.inputBuffer.getChannelData(0);
    if (input.length) chunks.push(new Float32Array(input));
  };
  silentGain.gain.value = 0;
  try {
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
  } catch {
    disconnect();
    return null;
  }

  return {
    stop() {
      disconnect();
      if (!chunks.length) return null;
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const samples = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      const wav = encodePcmWav({
        length: samples.length,
        numberOfChannels: 1,
        sampleRate: context.sampleRate,
        getChannelData: () => samples,
      });
      if (wav.size > MAX_NORMALIZED_AUDIO_BYTES) return null;
      return wav;
    },
    dispose() {
      disconnect();
      chunks.length = 0;
    },
  };
}

/** Decode, downmix, resample, and concatenate recording segments into one WAV. */
export async function mergeRecordedAudio(
  segments: readonly Blob[],
  maxBytes = MAX_NORMALIZED_AUDIO_BYTES,
): Promise<{ blob: Blob; mimeType: "audio/wav"; durationSec: number }> {
  if (!segments.length) throw new Error("没有可合并的录音片段。");
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) throw new Error("当前浏览器不支持音频合并，请改用单次录音。");
  let context: AudioContext | undefined;
  try {
    context = new AudioContextCtor();
    if (typeof context.resume === "function") await context.resume().catch(() => {});
    let decoded: DecodedAudio[];
    try {
      decoded = await Promise.all(
        segments.map(async (segment) => context!.decodeAudioData(await segment.arrayBuffer())),
      );
    } catch {
      throw new RecordedAudioFormatError(
        "当前浏览器无法读取录音片段。请重新录音，或更新 iOS/浏览器后重试。",
      );
    }
    const totalFrames = decoded.reduce(
      (sum, audio) =>
        sum +
        Math.max(0, Math.round((audio.length / audio.sampleRate) * TARGET_RECORDING_SAMPLE_RATE)),
      0,
    );
    if (!totalFrames) throw new Error("录音片段没有有效音频数据。");
    const samples = new Float32Array(totalFrames);
    let offset = 0;
    for (const audio of decoded) {
      const source = Array.from({ length: audio.numberOfChannels }, (_, channel) =>
        audio.getChannelData(channel),
      );
      const frames = Math.max(
        0,
        Math.round((audio.length / audio.sampleRate) * TARGET_RECORDING_SAMPLE_RATE),
      );
      for (let frame = 0; frame < frames; frame += 1) {
        const sourceFrame = Math.min(
          audio.length - 1,
          (frame * audio.sampleRate) / TARGET_RECORDING_SAMPLE_RATE,
        );
        const low = Math.floor(sourceFrame);
        const high = Math.min(audio.length - 1, low + 1);
        const fraction = sourceFrame - low;
        let value = 0;
        for (const channel of source) {
          value += (channel[low] ?? 0) * (1 - fraction) + (channel[high] ?? 0) * fraction;
        }
        samples[offset + frame] = Math.max(-1, Math.min(1, value / Math.max(1, source.length)));
      }
      offset += frames;
    }
    const wav = encodePcmWav({
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: TARGET_RECORDING_SAMPLE_RATE,
      getChannelData: () => samples,
    });
    if (wav.size > maxBytes) throw new Error("合并后的录音超过 25 MiB 限制，请缩短录音后重试。");
    return {
      blob: wav,
      mimeType: "audio/wav",
      durationSec: samples.length / TARGET_RECORDING_SAMPLE_RATE,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
