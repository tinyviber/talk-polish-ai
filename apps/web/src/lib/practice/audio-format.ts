type DecodedAudio = Pick<
  AudioBuffer,
  "length" | "numberOfChannels" | "sampleRate" | "getChannelData"
>;

type AudioContextConstructor = new () => AudioContext;

export const MAX_NORMALIZED_AUDIO_BYTES = 25 * 1024 * 1024;
export const TARGET_RECORDING_SAMPLE_RATE = 16_000;

const NORMALIZABLE_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
]);

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
  original: Blob,
  mimeType: string,
  decoded: DecodedAudio,
  maxBytes = MAX_NORMALIZED_AUDIO_BYTES,
) {
  const wav = encodePcmWav(decoded);
  return wav.size > maxBytes ? { blob: original, mimeType } : { blob: wav, mimeType: "audio/wav" };
}

/**
 * WebM, Ogg, MP4, and M4A are valid browser recording formats, but some
 * OpenAI-compatible ASR gateways cannot parse their duration. Normalize them
 * to WAV before upload while retaining the original Blob if this browser
 * cannot decode them.
 */
export async function normalizeRecordedAudio(
  blob: Blob,
  maxBytes = MAX_NORMALIZED_AUDIO_BYTES,
): Promise<{ blob: Blob; mimeType: string }> {
  const mimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() || "audio/webm";
  if (!isNormalizableAudioMimeType(mimeType)) {
    return { blob, mimeType };
  }
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) return { blob, mimeType };

  let context: AudioContext | undefined;
  try {
    context = new AudioContextCtor();
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    // PCM can be much larger than the compressed browser recording. Never
    // replace a manageable original with an oversized normalized payload.
    return chooseNormalizedAudio(blob, mimeType, decoded, maxBytes);
  } catch {
    return { blob, mimeType };
  } finally {
    if (context) await context.close().catch(() => {});
  }
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
    const decoded = await Promise.all(
      segments.map(async (segment) => context!.decodeAudioData(await segment.arrayBuffer())),
    );
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
