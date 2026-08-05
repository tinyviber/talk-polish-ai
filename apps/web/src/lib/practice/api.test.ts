import { afterEach, describe, expect, test, vi } from "vitest";
import { uploadQueuedAttempt } from "./api";

describe("queued attempt API recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("replays the same client attempt after GET stale recovery", async () => {
    const failedAttempt = {
      id: "att-stale",
      clientAttemptId: "client-stale",
      sessionId: "ses-1",
      index: 1 as const,
      status: "failed" as const,
      transcript: null,
      feedback: null,
      durationSec: 2,
      mocked: false,
      audio: null,
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    const readyAttempt = { ...failedAttempt, id: "att-replayed", status: "ready" as const };
    const responses = [
      {
        requestId: "bootstrap",
        learner: {
          id: "lnr-1",
          deviceId: "device-1",
          lang: "en",
          createdAt: "2026-08-05T00:00:00.000Z",
        },
        token: "token",
      },
      { requestId: "get", attempt: failedAttempt },
      { requestId: "post", attempt: readyAttempt },
    ];
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        const payload = responses.shift();
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadQueuedAttempt({
      clientAttemptId: "client-stale",
      sessionId: "ses-1",
      clientSessionId: "client-session-1",
      promptId: "prompt-1",
      attemptIndex: 1,
      duration: 2,
      mimeType: "audio/webm",
      blob: new Blob(["audio"], { type: "audio/webm" }),
      attemptId: "att-stale",
      syncStatus: "processing",
    });

    expect(result.attempt.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/attempts/att-stale");
    const postInit = fetchMock.mock.calls[2]?.[1];
    expect(postInit?.method).toBe("POST");
    expect((postInit?.body as FormData | undefined)?.get("clientAttemptId")).toBe("client-stale");
  });
});
