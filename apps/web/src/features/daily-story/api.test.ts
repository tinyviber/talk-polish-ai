import { afterEach, describe, expect, test, vi } from "vitest";
import { authenticatedApiFetch } from "@/lib/practice/api";
import { transcribeDailyStory } from "./api";

vi.mock("@/lib/practice/api", () => ({
  authenticatedApiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    status = 0;
  },
}));

const asr = {
  baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  apiKey: "test-key",
  model: "fun-asr-realtime",
  responseFormat: "json",
} as const;

describe("Daily Story transcription audio compatibility", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("blocks mp4 when the browser cannot decode it before uploading", async () => {
    vi.stubGlobal("window", {});

    await expect(
      transcribeDailyStory({
        audio: new Blob(["mp4"], { type: "audio/mp4" }),
        asr,
      }),
    ).rejects.toMatchObject({
      name: "DailyApiError",
      status: 422,
      message: expect.stringContaining("Fun-ASR-Realtime HTTP 接口仅支持 WAV、MP3 或 Opus"),
    });
    expect(authenticatedApiFetch).not.toHaveBeenCalled();
  });

  test("blocks mp4 when decoding fails before uploading", async () => {
    const close = vi.fn(async () => undefined);
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => {
        throw new Error("unsupported audio");
      });
      close = close;
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });

    await expect(
      transcribeDailyStory({
        audio: new Blob(["mp4"], { type: "audio/mp4" }),
        asr,
      }),
    ).rejects.toMatchObject({
      name: "DailyApiError",
      status: 422,
      message: expect.stringContaining("当前录音无法转换为兼容格式"),
    });
    expect(close).toHaveBeenCalledOnce();
    expect(authenticatedApiFetch).not.toHaveBeenCalled();
  });

  test.each(["audio/mp3", "audio/x-wav", "audio/opus"])(
    "allows %s to reach the transcription API",
    async (mimeType) => {
      const fetchMock = vi.mocked(authenticatedApiFetch);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ transcript: "hello" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("window", {
        location: { origin: "http://localhost" },
        localStorage: {
          getItem: () => null,
          setItem: () => undefined,
        },
      });

      await expect(
        transcribeDailyStory({
          audio: new Blob(["audio"], { type: mimeType }),
          asr,
        }),
      ).resolves.toEqual({ transcript: "hello" });
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      expect((body.get("audio") as File).type).toBe(mimeType);
    },
  );

  test("allows WAV to reach the transcription API", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    await expect(
      transcribeDailyStory({
        audio: new Blob(["RIFF"], { type: "audio/wav" }),
        asr,
      }),
    ).resolves.toEqual({ transcript: "hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((body.get("audio") as File).type).toBe("audio/wav");
  });
});
