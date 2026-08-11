import { describe, expect, test } from "vitest";
import {
  createDashScopeFunAsrDirectBody,
  getDashScopeFunAsrDirectSupport,
  parseDashScopeFunAsrDirectTranscript,
} from "./asr-direct";

describe("DashScope Fun-ASR direct browser helper", () => {
  test("builds the native Base64 audio body used by the direct HTTP endpoint", () => {
    const body = createDashScopeFunAsrDirectBody(
      "fun-asr-realtime",
      Uint8Array.from([0, 1, 2]),
      "audio/wav; codecs=pcm",
    );

    expect(body).toMatchObject({
      model: "fun-asr-realtime",
      parameters: { format: "wav" },
      resources: [],
    });
    expect(body.input.messages[0]?.content[0]?.audio).toBe("data:audio/wav;base64,AAEC");
  });

  test("parses both native output shapes without trimming the transcript", () => {
    expect(parseDashScopeFunAsrDirectTranscript({ output: { text: " hello " } })).toEqual({
      transcript: " hello ",
    });
    expect(
      parseDashScopeFunAsrDirectTranscript({ output: { sentence: { text: "fallback" } } }),
    ).toEqual({
      transcript: "fallback",
    });
  });

  test("reports public origins as direct-capable and workspace origins as CORS-blocked", () => {
    expect(
      getDashScopeFunAsrDirectSupport({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "fun-asr-realtime",
      }),
    ).toMatchObject({
      supported: true,
      enabled: false,
      active: false,
    });

    expect(
      getDashScopeFunAsrDirectSupport(
        {
          baseUrl: "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          model: "fun-asr-realtime",
        },
        true,
      ),
    ).toMatchObject({
      supported: false,
      enabled: true,
      active: false,
      message: expect.stringContaining("workspace DashScope endpoint 不支持浏览器 CORS"),
    });
  });
});
