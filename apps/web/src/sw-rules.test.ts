import { describe, expect, test } from "vitest";
import { isNetworkOnlyPath, isPublicNavigationRequest, isPublicPromptsRequest } from "./sw-rules";

describe("service worker cache boundaries", () => {
  test("allows only unauthenticated GET prompts in runtime cache", () => {
    const url = new URL("https://app.example.com/api/prompts?lang=en");
    expect(isPublicPromptsRequest(url, new Request(url))).toBe(true);
    expect(
      isPublicPromptsRequest(
        url,
        new Request(url, { headers: { Authorization: "Bearer secret" } }),
      ),
    ).toBe(false);
    expect(isPublicPromptsRequest(url, new Request(url, { method: "POST" }))).toBe(false);
    expect(
      isPublicPromptsRequest(url, new Request(url, { headers: { Cookie: "session=secret" } })),
    ).toBe(false);
  });

  test("keeps learner, audio, provider and realtime paths network-only", () => {
    for (const path of [
      "/api/learners/anonymous",
      "/api/sessions/ses_1",
      "/api/sessions/ses_1/attempts",
      "/api/audio/recordings/aud_1",
      "/api/providers/diagnostics",
      "/api/daily-story/start",
      "/api/daily-story/transcribe",
      "/api/daily-story/tts",
      "/realtime/session",
    ]) {
      expect(isNetworkOnlyPath(new URL(`https://app.example.com${path}`))).toBe(true);
    }
    expect(isNetworkOnlyPath(new URL("https://app.example.com/assets/app-abc.js"))).toBe(false);
  });

  test("does not treat cross-origin API paths as this service worker's network-only routes", () => {
    expect(
      isNetworkOnlyPath(
        new URL(
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        ),
        "https://app.example.com",
      ),
    ).toBe(false);
  });

  test("does not cache user-specific navigation requests", () => {
    const url = new URL("https://app.example.com/practice");
    const navigation = (headers?: HeadersInit) =>
      ({ mode: "navigate", headers: new Headers(headers) }) as Request;
    expect(isPublicNavigationRequest(navigation(), url)).toBe(true);
    expect(isPublicNavigationRequest(navigation({ Cookie: "session=secret" }), url)).toBe(false);
    expect(
      isPublicNavigationRequest(
        navigation(),
        new URL("https://cdn.example.com/practice"),
        "https://app.example.com",
      ),
    ).toBe(false);
  });
});
