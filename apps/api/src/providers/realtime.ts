import { randomUUID } from "node:crypto";
import { ProviderConfigurationError, ProviderRequestError } from "./http";

export type RealtimeConfig = {
  enabled: boolean;
  url?: string;
  apiKey?: string;
  model?: string;
  protocol: "websocket" | "webrtc-unified";
  timeoutMs: number;
};

export type RealtimeProvider = {
  readonly name: string;
  readonly configured: boolean;
  checkConfiguration(): void;
  smokeTest(requestId?: string): Promise<void>;
};

export function createRealtimeProvider(config: RealtimeConfig): RealtimeProvider {
  const configured = Boolean(config.enabled && config.url && config.apiKey && config.model);
  return {
    name: "openai-compatible-realtime",
    configured,
    checkConfiguration() {
      if (!config.enabled) throw new ProviderConfigurationError("Realtime feature is disabled");
      if (config.protocol !== "websocket") {
        throw new ProviderConfigurationError("Only websocket Realtime is implemented");
      }
      if (!config.url || !config.apiKey || !config.model) {
        throw new ProviderConfigurationError("Realtime configuration is incomplete");
      }
      if (!/^wss?:\/\//i.test(config.url)) {
        throw new ProviderConfigurationError("Realtime URL must use ws:// or wss://");
      }
    },
    async smokeTest(requestId?: string) {
      this.checkConfiguration();
      const traceId: string = requestId ?? randomUUID();
      const socket = new WebSocket(config.url!, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
          "x-request-id": traceId,
        },
      });
      const timeout = setTimeout(() => socket.close(), config.timeoutMs);
      try {
        // Install message listener before opening: providers may emit
        // `session.created` immediately after the WebSocket handshake.
        const createdEvent = waitForEvent(socket, "session.created", config.timeoutMs);
        await waitForOpen(socket, config.timeoutMs);
        const created = await createdEvent;
        if (!created)
          throw new ProviderRequestError("Realtime session was not created", {
            code: "response",
            retryCount: 0,
          });
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: { model: config.model },
          }),
        );
        const updated = await waitForEvent(socket, "session.updated", config.timeoutMs);
        if (!updated)
          throw new ProviderRequestError("Realtime session update failed", {
            code: "response",
            retryCount: 0,
          });
      } finally {
        clearTimeout(timeout);
        socket.close();
      }
    },
  };
}

function waitForOpen(socket: WebSocket, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProviderRequestError("Realtime connection failed", { code: "network", retryCount: 0 }),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProviderRequestError("Realtime connection timed out", {
          code: "timeout",
          retryCount: 0,
        }),
      );
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

function waitForEvent(socket: WebSocket, type: string, timeoutMs: number) {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: unknown };
        if (parsed.type === type) {
          settled = true;
          cleanup();
          resolve(true);
        }
      } catch {
        // Ignore unrelated protocol frames; timeout returns safe failure.
      }
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProviderRequestError("Realtime protocol failed", { code: "network", retryCount: 0 }),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProviderRequestError("Realtime event timed out", { code: "timeout", retryCount: 0 }),
      );
    }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}
