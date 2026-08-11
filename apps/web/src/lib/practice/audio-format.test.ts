import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chooseNormalizedAudio,
  createPcmWavCapture,
  encodePcmWav,
  isNormalizableAudioMimeType,
  mergeRecordedAudio,
  normalizeRecordedAudio,
  RecordedAudioFormatError,
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

  test("rejects normalized WAV that exceeds size limit", async () => {
    const original = new Blob(["compressed"], { type: "audio/webm" });
    const decoded = {
      length: 2,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([-1, 1]),
    } as unknown as AudioBuffer;
    expect(() => chooseNormalizedAudio(original, original.type, decoded, 44)).toThrow(
      RecordedAudioFormatError,
    );
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

  test.each(["audio/mp4", "audio/webm"])(
    "retains %s for ordinary providers when decoding fails",
    async (mimeType) => {
      const close = vi.fn(async () => undefined);
      class FakeAudioContext {
        decodeAudioData = vi.fn(async () => {
          throw new Error("unsupported audio");
        });
        close = close;
      }
      vi.stubGlobal("window", { AudioContext: FakeAudioContext });

      const original = new Blob(["compressed"], { type: mimeType });

      await expect(normalizeRecordedAudio(original)).resolves.toEqual({
        blob: original,
        mimeType,
      });
      await expect(normalizeRecordedAudio(original, { strict: true })).rejects.toThrow(
        RecordedAudioFormatError,
      );
      expect(close).toHaveBeenCalledOnce();
    },
  );

  test("retains browser recording without AudioContext for ordinary providers", async () => {
    vi.stubGlobal("window", {});
    const original = new Blob(["compressed"], { type: "audio/mp4" });

    await expect(normalizeRecordedAudio(original)).resolves.toEqual({
      blob: original,
      mimeType: "audio/mp4",
    });
    await expect(normalizeRecordedAudio(original, { requireWav: true })).rejects.toThrow(
      RecordedAudioFormatError,
    );
  });

  test.each(["audio/mp4", "audio/webm", "audio/ogg", "audio/aac", "audio/opus"])(
    "strict mode rejects non-Fun-ASR MIME %s before decode",
    async (mimeType) => {
      const decodeAudioData = vi.fn();
      class FakeAudioContext {
        decodeAudioData = decodeAudioData;
        close = vi.fn(async () => undefined);
      }
      vi.stubGlobal("window", { AudioContext: FakeAudioContext });

      await expect(
        normalizeRecordedAudio(new Blob(["compressed"], { type: mimeType }), {
          strict: true,
        }),
      ).rejects.toThrow(RecordedAudioFormatError);
      expect(decodeAudioData).not.toHaveBeenCalled();
    },
  );

  test("captures ScriptProcessor PCM as WAV fallback", async () => {
    const processors: Array<{ onaudioprocess: ((event: AudioProcessingEvent) => void) | null }> =
      [];
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;
    const context = {
      sampleRate: 48_000,
      destination: {},
      createScriptProcessor: vi.fn(() => {
        const processor = {
          onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        processors.push(processor);
        return processor;
      }),
      createGain: vi.fn(() => ({
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    } as unknown as AudioContext;

    const capture = createPcmWavCapture(context, source);
    expect(capture).not.toBeNull();
    processors[0]!.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([-1, 1]) },
    } as unknown as AudioProcessingEvent);
    const wav = capture!.stop();
    expect(wav?.type).toBe("audio/wav");
    expect(new Uint8Array(await wav!.arrayBuffer()).slice(0, 4)).toEqual(
      new TextEncoder().encode("RIFF"),
    );
  });

  test("disconnects every node when PCM capture wiring fails", () => {
    const processor = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = {
      connect: vi.fn(() => {
        throw new Error("connect failed");
      }),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;
    const context = {
      sampleRate: 48_000,
      destination: {},
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => gain),
    } as unknown as AudioContext;

    expect(createPcmWavCapture(context, source)).toBeNull();
    expect(processor.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
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
