import { describe, expect, test } from "bun:test";
import {
  createDashScopeAsrBody,
  isDashScopeCompatibleAsrUrl,
  parseDashScopeTranscript,
} from "./dashscope-compatible-speech-to-text";
import { DailyProviderRequestError } from "./safe-https-client";

describe("DashScope OpenAI-compatible ASR", () => {
  test("recognizes the Beijing compatible-mode endpoint", () => {
    expect(
      isDashScopeCompatibleAsrUrl(
        "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      ),
    ).toBe(true);
    expect(isDashScopeCompatibleAsrUrl("https://api.deepseek.com/v1")).toBe(false);
    expect(
      isDashScopeCompatibleAsrUrl(
        "https://ws-1ojsn1omateq5fkp.cn-beijing.maas.aliyuncs.com/api/v1",
      ),
    ).toBe(false);
  });

  test("builds the input_audio Base64 request required by DashScope", () => {
    const body = createDashScopeAsrBody(
      "qwen3-asr-flash",
      Uint8Array.from([0, 1, 2]),
      "audio/wav; codecs=pcm",
      "en",
    );
    expect(body).toMatchObject({
      model: "qwen3-asr-flash",
      stream: false,
      asr_options: { language: "en", enable_itn: false },
    });
    expect(body.messages[0]?.content[0]?.input_audio.data).toBe("data:audio/wav;base64,AAEC");
  });

  test("parses OpenAI-compatible message content", () => {
    expect(
      parseDashScopeTranscript({
        choices: [{ message: { content: " hello from qwen " } }],
      }),
    ).toEqual({ text: " hello from qwen ", provider: "dashscope-compatible-asr" });
  });

  test("preserves whitespace in content arrays", () => {
    expect(
      parseDashScopeTranscript({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "  hello " },
                { type: "text", text: " from qwen  " },
              ],
            },
          },
        ],
      }),
    ).toEqual({ text: "  hello  from qwen  ", provider: "dashscope-compatible-asr" });
  });

  test("rejects missing or whitespace-only content", () => {
    for (const content of [undefined, "   ", [{ type: "text", text: " \n\t" }]]) {
      expect(() => parseDashScopeTranscript({ choices: [{ message: { content } }] })).toThrow(
        DailyProviderRequestError,
      );
    }
  });
});
