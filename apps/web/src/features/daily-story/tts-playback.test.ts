import { afterEach, describe, expect, test, vi } from "vitest";
import { releaseTransientTtsPlayback } from "./tts-playback";

afterEach(() => vi.unstubAllGlobals());

describe("transient Daily Story TTS playback", () => {
  test("releases blob URL and detaches audio source", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL });
    const audio = { pause: vi.fn(), removeAttribute: vi.fn() };

    releaseTransientTtsPlayback({ audio, url: "blob:daily-tts" });

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:daily-tts");
  });
});
