type DecodedAudio = Pick<
  AudioBuffer,
  "length" | "numberOfChannels" | "sampleRate" | "getChannelData"
>;

type AudioContextConstructor = new () => AudioContext;

export const MAX_NORMALIZED_AUDIO_BYTES = 25 * 1024 * 1024;

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
 * WebM is a valid browser recording format, but some OpenAI-compatible ASR
 * gateways cannot parse its duration. Normalize it to WAV before upload while
 * retaining the original Blob if this browser cannot decode it.
 */
export async function normalizeRecordedAudio(
  blob: Blob,
  maxBytes = MAX_NORMALIZED_AUDIO_BYTES,
): Promise<{ blob: Blob; mimeType: string }> {
  const mimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() || "audio/webm";
  if (mimeType !== "audio/webm" && mimeType !== "audio/ogg") {
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
