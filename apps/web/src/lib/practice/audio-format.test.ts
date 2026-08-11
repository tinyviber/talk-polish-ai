import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chooseNormalizedAudio,
  encodePcmWav,
  isNormalizableAudioMimeType,
  mergeRecordedAudio,
  normalizeRecordedAudio,
} from "./audio-format";

describe("audio format", () => {
  test("recognizes recorded formats that can be normalized", () => {
    expect(isNormalizableAudioMimeType("audio/mp4")).toBe(true);
    expect(isNormalizableAudioMimeType("audio/m4a")).toBe(true);
    expect(isNormalizableAudioMimeType("audio/webm")).toBe(true);
    expect(isNormalizableAudioMimeType("audio/ogg")).toBe(true);
    expect(isNormalizableAudioMimeType("audio/wav")).toBe(false);
    expect(isNormalizableAudioMimeType("audio/mpeg")).toBe(false);
    expect(isNormalizableAudioMimeType("video/mp4")).toBe(false);
  });

  test("encodes browser PCM samples as a WAV file", async () => {
    const wav = encodePcmWav({
      length: 2,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([-1, 1]),
    });
    const bytes = new Uint8Array(await wav.arrayBuffer());

    expect(wav.type).toBe("audio/wav");
    expect(bytes.byteLength).toBe(48);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getInt16(44, true)).toBe(-32_768);
    expect(new DataView(bytes.buffer).getInt16(46, true)).toBe(32_767);
  });

  test("keeps original recording when normalized WAV exceeds size limit", async () => {
    const original = new Blob(["compressed"], { type: "audio/webm" });
    const decoded = {
      length: 2,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([-1, 1]),
    } as unknown as AudioBuffer;
    const normalized = chooseNormalizedAudio(original, original.type, decoded, 44);
    expect(normalized.blob).toBe(original);
    expect(normalized.mimeType).toBe("audio/webm");
  });

  test("decodes a recording to WAV and closes the AudioContext", async () => {
    const close = vi.fn(async () => undefined);
    const decoded = {
      length: 2,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([-1, 1]),
    } as unknown as AudioBuffer;
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => decoded);
      close = close;
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });

    const original = new Blob(["compressed"], { type: "audio/mp4; codecs=mp4a.40.2" });
    const normalized = await normalizeRecordedAudio(original);

    expect(normalized.blob.type).toBe("audio/wav");
    expect(normalized.mimeType).toBe("audio/wav");
    expect(normalized.blob).not.toBe(original);
    expect(close).toHaveBeenCalledOnce();
  });

  test("keeps the original recording and closes the AudioContext when decoding fails", async () => {
    const close = vi.fn(async () => undefined);
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => {
        throw new Error("unsupported audio");
      });
      close = close;
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });

    const original = new Blob(["compressed"], { type: "audio/m4a" });
    const normalized = await normalizeRecordedAudio(original);

    expect(normalized.blob).toBe(original);
    expect(normalized.mimeType).toBe("audio/m4a");
    expect(close).toHaveBeenCalledOnce();
  });

  test("keeps the original recording when AudioContext is unavailable", async () => {
    vi.stubGlobal("window", {});
    const original = new Blob(["compressed"], { type: "audio/mp4" });
    const normalized = await normalizeRecordedAudio(original);

    expect(normalized.blob).toBe(original);
    expect(normalized.mimeType).toBe("audio/mp4");
  });

  test("merges segments into mono 16 kHz WAV in order", async () => {
    const decoded = [
      {
        length: 2,
        numberOfChannels: 2,
        sampleRate: 8_000,
        getChannelData: (channel: number) => new Float32Array(channel === 0 ? [0, 1] : [0, 1]),
      },
      {
        length: 2,
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([-1, 0]),
      },
    ];
    class FakeAudioContext {
      private index = 0;
      decodeAudioData = vi.fn(async () => decoded[this.index++]);
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const merged = await mergeRecordedAudio([
      new Blob(["first"], { type: "audio/webm" }),
      new Blob(["second"], { type: "audio/mp4" }),
    ]);
    const bytes = new Uint8Array(await merged.blob.arrayBuffer());
    expect(merged.mimeType).toBe("audio/wav");
    expect(merged.durationSec).toBe(6 / 16_000);
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(1);
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
