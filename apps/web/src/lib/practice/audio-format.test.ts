import { describe, expect, test } from "vitest";
import { encodePcmWav } from "./audio-format";

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
});
