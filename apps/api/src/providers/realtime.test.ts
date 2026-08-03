import { describe, expect, test } from "bun:test";
import { realtimeHandshakeUrl } from "./realtime";

describe("realtime handshake", () => {
  test("selects the model in the handshake URL", () => {
    expect(realtimeHandshakeUrl("wss://example.com/v1/realtime", "gpt-realtime")).toBe(
      "wss://example.com/v1/realtime?model=gpt-realtime",
    );
  });

  test("never overrides an operator-provided model", () => {
    expect(realtimeHandshakeUrl("wss://example.com/v1/realtime?model=custom", "gpt-realtime")).toBe(
      "wss://example.com/v1/realtime?model=custom",
    );
  });
});
