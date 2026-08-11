import { afterEach, describe, expect, test, vi } from "vitest";
import { authenticatedApiFetch } from "@/lib/practice/api";
import { checkDailyProvider, transcribeDailyStory } from "./api";

vi.mock("@/lib/practice/api", () => ({
  authenticatedApiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    status = 0;
  },
}));

const workspaceAsr = {
  baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  apiKey: "test-key",
  model: "fun-asr-realtime",
  responseFormat: "json",
} as const;

const publicAsr = {
  ...workspaceAsr,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
} as const;

describe("Daily Story transcription audio compatibility", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("allows mp4 to reach the proxy transcription API when the browser cannot decode it", async () => {
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
        audio: new Blob(["mp4"], { type: "audio/mp4" }),
        asr: workspaceAsr,
      }),
    ).resolves.toEqual({ transcript: "hello" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const audio = body.get("audio") as File;
    expect(audio.type).toBe("audio/mp4");
    expect(audio.name).toBe("recording.m4a");
  });

  test("allows mp4 to reach the proxy transcription API when local normalization fails", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const close = vi.fn(async () => undefined);
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => {
        throw new Error("unsupported audio");
      });
      close = close;
    }
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      location: { origin: "http://localhost" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    await expect(
      transcribeDailyStory({
        audio: new Blob(["mp4"], { type: "audio/mp4" }),
        asr: workspaceAsr,
      }),
    ).resolves.toEqual({ transcript: "hello" });

    expect(close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((body.get("audio") as File).type).toBe("audio/mp4");
  });

  test("still blocks unsupported direct Fun-ASR audio when normalization cannot make it compatible", async () => {
    vi.stubGlobal("window", {});

    await expect(
      transcribeDailyStory({
        audio: new Blob(["mp4"], { type: "audio/mp4" }),
        asr: publicAsr,
        directAsr: true,
      }),
    ).rejects.toMatchObject({
      name: "DailyApiError",
      status: 422,
      message: expect.stringContaining("Fun-ASR-Realtime HTTP 接口仅支持 WAV、MP3 或 Opus"),
    });
    expect(authenticatedApiFetch).not.toHaveBeenCalled();
  });

  test.each(["audio/webm", "audio/ogg", "audio/aac", "audio/mp3", "audio/x-wav", "audio/opus"])(
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
          asr: workspaceAsr,
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
        asr: workspaceAsr,
      }),
    ).resolves.toEqual({ transcript: "hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((body.get("audio") as File).type).toBe("audio/wav");
  });

  test("uses same-origin proxy by default even for DashScope Fun-ASR", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    const directFetch = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: "proxy hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", directFetch);
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
        asr: workspaceAsr,
      }),
    ).resolves.toEqual({ transcript: "proxy hello" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/daily-story/transcribe");
    expect(directFetch).not.toHaveBeenCalled();
  });

  test("uses DashScope native HTTP directly only on the fixed public DashScope origins", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    const directFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: { text: " direct hello " } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", directFetch);
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
        asr: publicAsr,
        directAsr: true,
      }),
    ).resolves.toEqual({ transcript: " direct hello " });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    const init = directFetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("omit");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "fun-asr-realtime",
      parameters: { format: "wav" },
      resources: [],
    });
  });

  test("routes stale workspace direct ASR opt-ins back through the same-origin proxy", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: "proxy hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    await expect(
      transcribeDailyStory({
        audio: new Blob(["wav"], { type: "audio/wav" }),
        asr: workspaceAsr,
        directAsr: true,
      }),
    ).resolves.toEqual({ transcript: "proxy hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/daily-story/transcribe");
    expect(directFetch).not.toHaveBeenCalled();
  });

  test("routes stale unsupported direct ASR opt-ins through the proxy instead of forcing direct", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: "proxy hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    await expect(
      transcribeDailyStory({
        audio: new Blob(["wav"], { type: "audio/wav" }),
        asr: {
          ...publicAsr,
          model: "qwen3-asr-flash",
        },
        directAsr: true,
      }),
    ).resolves.toEqual({ transcript: "proxy hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/daily-story/transcribe");
    expect(directFetch).not.toHaveBeenCalled();
  });

  test("surfaces actionable public direct network/CORS failures without leaking the API key", async () => {
    const directFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", directFetch);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });

    const error = await (async () => {
      try {
        await transcribeDailyStory({
          audio: new Blob(["wav"], { type: "audio/wav" }),
          asr: publicAsr,
          directAsr: true,
        });
        throw new Error("expected direct ASR to fail");
      } catch (cause) {
        return cause as Error;
      }
    })();

    expect(error).toMatchObject({
      name: "DailyApiError",
      message: expect.stringContaining("当前公共 DashScope endpoint 支持浏览器直连"),
    });
    expect(error.message).not.toContain(publicAsr.apiKey);
  });

  test("keeps direct opt-in local and out of the strict provider-check payload", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ capability: "asr", status: "connected" }), {
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
      checkDailyProvider({
        capability: "asr",
        provider: workspaceAsr,
      }),
    ).resolves.toEqual({ capability: "asr", status: "connected" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      capability: "asr",
      provider: workspaceAsr,
    });
    expect(body).not.toHaveProperty("directAsr");
  });

  test("checks actual direct HTTP capability in-browser when ASR opt-in is enabled on public origins", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    const directFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: { sentence: { text: "probe ok" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", directFetch);

    await expect(
      checkDailyProvider({
        capability: "asr",
        provider: publicAsr,
        directAsr: true,
      }),
    ).resolves.toEqual({ capability: "asr", status: "connected" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(directFetch).toHaveBeenCalledOnce();
  });

  test("routes workspace provider checks with stale direct opt-ins through the server proxy", async () => {
    const fetchMock = vi.mocked(authenticatedApiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ capability: "asr", status: "connected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);

    await expect(
      checkDailyProvider({
        capability: "asr",
        provider: workspaceAsr,
        directAsr: true,
      }),
    ).resolves.toEqual({ capability: "asr", status: "connected" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/daily-story/provider-check");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      capability: "asr",
      provider: workspaceAsr,
    });
    expect(directFetch).not.toHaveBeenCalled();
  });
});
