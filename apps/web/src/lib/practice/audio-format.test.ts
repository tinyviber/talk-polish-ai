import { describe, expect, test } from "vitest";
import { chooseNormalizedAudio, encodePcmWav } from "./audio-format";

describe("audio format", () => {
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
});
